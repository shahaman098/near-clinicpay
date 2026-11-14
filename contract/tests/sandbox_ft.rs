//! End-to-end tests for stablecoin (NEP-141) invoices: build ClinicPay and a
//! minimal test token (`../test-token`, 6 decimals like USDC), deploy both to a
//! local NEAR sandbox node, and move real (sandbox) token balances.

use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use std::process::Command;

const USD: u128 = 1_000_000; // 6 decimals

fn build(manifest: &str, wasm: &str) -> Vec<u8> {
    let status = Command::new("cargo")
        .args([
            "build",
            "--manifest-path",
            manifest,
            "--target",
            "wasm32-unknown-unknown",
            "--release",
        ])
        .status()
        .expect("cargo build failed to start");
    assert!(status.success(), "wasm build failed for {manifest}");
    std::fs::read(wasm).unwrap_or_else(|_| panic!("wasm missing: {wasm}"))
}

struct Env {
    _worker: Worker<Sandbox>,
    pay: Contract,
    token: Contract,
    clinic: Account,
    patient: Account,
    insurer: Account,
}

async fn register(token: &Contract, who: &str) -> anyhow::Result<()> {
    token
        .as_account()
        .call(token.id(), "storage_deposit")
        .args_json(json!({"account_id": who, "registration_only": true}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn fund(token: &Contract, who: &Account, amount: u128) -> anyhow::Result<()> {
    token
        .as_account()
        .call(token.id(), "ft_transfer")
        .args_json(json!({"receiver_id": who.id(), "amount": amount.to_string()}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn balance(token: &Contract, who: &str) -> anyhow::Result<u128> {
    let v: String = token
        .view("ft_balance_of")
        .args_json(json!({"account_id": who}))
        .await?
        .json()?;
    Ok(v.parse()?)
}

/// `register_clinic = false` leaves the clinic without storage on the token, so
/// every forward to it fails.
async fn setup(register_clinic: bool) -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let pay_wasm = build(
        "Cargo.toml",
        "target/wasm32-unknown-unknown/release/clinicpay.wasm",
    );
    let token_wasm = build(
        "../test-token/Cargo.toml",
        "../test-token/target/wasm32-unknown-unknown/release/test_token.wasm",
    );
    let pay = worker.dev_deploy(&pay_wasm).await?;
    pay.call("new").transact().await?.into_result()?;
    let token = worker.dev_deploy(&token_wasm).await?;
    token
        .call("new")
        .args_json(json!({
            "owner_id": token.id(),
            "total_supply": (1_000_000 * USD).to_string(),
            "decimals": 6,
            "symbol": "tUSDC"
        }))
        .transact()
        .await?
        .into_result()?;

    let clinic = worker.dev_create_account().await?;
    let patient = worker.dev_create_account().await?;
    let insurer = worker.dev_create_account().await?;
    for who in [
        pay.id().as_str(),
        patient.id().as_str(),
        insurer.id().as_str(),
    ] {
        register(&token, who).await?;
    }
    if register_clinic {
        register(&token, clinic.id().as_str()).await?;
    }
    fund(&token, &patient, 10 * USD).await?;
    fund(&token, &insurer, 40 * USD).await?;

    clinic
        .call(pay.id(), "create_invoice")
        .args_json(json!({
            "id": "FT-1",
            "memo": "Visit 12 Nov",
            "lines": [{"description": "Treatment", "amount": (50 * USD).to_string()}],
            "shares": [
                {"label": "Patient co-pay", "payer": patient.id(), "amount": (10 * USD).to_string()},
                {"label": "Insurer", "payer": insurer.id(), "amount": (40 * USD).to_string()}
            ],
            "due_ms": null,
            "token": token.id()
        }))
        .transact()
        .await?
        .into_result()?;

    Ok(Env {
        _worker: worker,
        pay,
        token,
        clinic,
        patient,
        insurer,
    })
}

async fn pay_ft(
    env: &Env,
    from: &Account,
    amount: u128,
    msg: Value,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(from
        .call(env.token.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": env.pay.id(),
            "amount": amount.to_string(),
            "msg": msg.to_string()
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?)
}

async fn invoice(env: &Env) -> anyhow::Result<Value> {
    Ok(env
        .pay
        .view("get_invoice")
        .args_json(json!({"invoice_id": "FT-1"}))
        .await?
        .json()?)
}

async fn status(env: &Env) -> anyhow::Result<String> {
    let v: Value = env
        .pay
        .view("get_status")
        .args_json(json!({"invoice_id": "FT-1"}))
        .await?
        .json()?;
    Ok(v.as_str().unwrap().to_string())
}

#[tokio::test]
async fn stablecoin_split_payment_lands_with_the_clinic() -> anyhow::Result<()> {
    let env = setup(true).await?;
    assert_eq!(status(&env).await?, "Open");

    let r = pay_ft(
        &env,
        &env.patient,
        10 * USD,
        json!({"invoice_id": "FT-1", "share_index": 0}),
    )
    .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert!(r
        .logs()
        .iter()
        .any(|l| l.contains("share_paid") && l.contains(env.token.id().as_str())));
    assert_eq!(status(&env).await?, "PartiallyPaid");

    let r = pay_ft(
        &env,
        &env.insurer,
        40 * USD,
        json!({"invoice_id": "FT-1", "share_index": 1}),
    )
    .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(status(&env).await?, "Paid");

    assert_eq!(
        balance(&env.token, env.clinic.id().as_str()).await?,
        50 * USD,
        "clinic gets every token"
    );
    assert_eq!(
        balance(&env.token, env.pay.id().as_str()).await?,
        0,
        "contract holds nothing"
    );
    assert_eq!(balance(&env.token, env.patient.id().as_str()).await?, 0);
    assert_eq!(balance(&env.token, env.insurer.id().as_str()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn unregistered_clinic_reverts_payment_and_refunds_payer() -> anyhow::Result<()> {
    let env = setup(false).await?;
    let r = pay_ft(
        &env,
        &env.patient,
        10 * USD,
        json!({"invoice_id": "FT-1", "share_index": 0}),
    )
    .await?;
    assert!(
        r.logs().iter().any(|l| l.contains("payment_reverted")),
        "the forward must fail and be reverted by ClinicPay, not rejected up front: {:?}",
        r.logs()
    );

    let inv = invoice(&env).await?;
    assert_eq!(inv["shares"][0]["state"], "Open", "share must be reopened");
    assert_eq!(
        balance(&env.token, env.patient.id().as_str()).await?,
        10 * USD,
        "payer refunded in full"
    );
    assert_eq!(
        balance(&env.token, env.pay.id().as_str()).await?,
        0,
        "contract holds nothing"
    );
    Ok(())
}

#[tokio::test]
async fn wrong_amount_or_payer_is_returned_in_full() -> anyhow::Result<()> {
    let env = setup(true).await?;
    // patient sends 9 instead of 10
    let _ = pay_ft(
        &env,
        &env.patient,
        9 * USD,
        json!({"invoice_id": "FT-1", "share_index": 0}),
    )
    .await?;
    // insurer tries the patient's share
    let _ = pay_ft(
        &env,
        &env.insurer,
        10 * USD,
        json!({"invoice_id": "FT-1", "share_index": 0}),
    )
    .await?;

    assert_eq!(status(&env).await?, "Open");
    assert_eq!(
        balance(&env.token, env.patient.id().as_str()).await?,
        10 * USD
    );
    assert_eq!(
        balance(&env.token, env.insurer.id().as_str()).await?,
        40 * USD
    );
    assert_eq!(balance(&env.token, env.clinic.id().as_str()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn clinic_refund_returns_tokens_to_the_payer() -> anyhow::Result<()> {
    let env = setup(true).await?;
    let r = pay_ft(
        &env,
        &env.patient,
        10 * USD,
        json!({"invoice_id": "FT-1", "share_index": 0}),
    )
    .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(
        balance(&env.token, env.clinic.id().as_str()).await?,
        10 * USD
    );

    let r = pay_ft(
        &env,
        &env.clinic,
        10 * USD,
        json!({"invoice_id": "FT-1", "share_index": 0, "action": "refund"}),
    )
    .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert!(r.logs().iter().any(|l| l.contains("share_refunded")));

    assert_eq!(invoice(&env).await?["shares"][0]["state"], "Refunded");
    assert_eq!(
        balance(&env.token, env.patient.id().as_str()).await?,
        10 * USD,
        "patient made whole"
    );
    assert_eq!(balance(&env.token, env.clinic.id().as_str()).await?, 0);
    assert_eq!(balance(&env.token, env.pay.id().as_str()).await?, 0);
    Ok(())
}
