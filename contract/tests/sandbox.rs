//! End-to-end tests: build the real wasm, deploy it to a local NEAR sandbox node,
//! and move real (sandbox) balances between accounts.

use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};
use std::process::Command;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// Sandbox receipts (gas refunds, forwarded transfers) settle a block or two
/// after `transact()` returns, so wait before comparing balances.
async fn settle() {
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
}

fn build_wasm() -> Vec<u8> {
    let status = Command::new("cargo")
        .args(["build", "--target", "wasm32-unknown-unknown", "--release"])
        .status()
        .expect("cargo build failed to start");
    assert!(status.success(), "wasm build failed");
    std::fs::read("target/wasm32-unknown-unknown/release/clinicpay.wasm").expect("wasm missing")
}

async fn setup() -> anyhow::Result<(
    near_workspaces::Worker<near_workspaces::network::Sandbox>,
    Contract,
    Account,
    Account,
    Account,
)> {
    let worker = near_workspaces::sandbox().await?;
    let wasm = build_wasm();
    let contract = worker.dev_deploy(&wasm).await?;
    contract.call("new").transact().await?.into_result()?;
    let clinic = worker.dev_create_account().await?;
    let patient = worker.dev_create_account().await?;
    let insurer = worker.dev_create_account().await?;
    Ok((worker, contract, clinic, patient, insurer))
}

async fn create_invoice(
    contract: &Contract,
    clinic: &Account,
    patient: &Account,
    insurer: &Account,
) -> anyhow::Result<()> {
    clinic
        .call(contract.id(), "create_invoice")
        .args_json(json!({
            "id": "INV-1",
            "memo": "Visit 12 Nov",
            "lines": [
                {"description": "Consultation", "amount": (2 * NEAR).to_string()},
                {"description": "Blood panel", "amount": (3 * NEAR).to_string()}
            ],
            "shares": [
                {"label": "Patient co-pay", "payer": patient.id(), "amount": NEAR.to_string()},
                {"label": "Insurer", "payer": insurer.id(), "amount": (4 * NEAR).to_string()}
            ],
            "due_ms": null
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn status(contract: &Contract) -> anyhow::Result<String> {
    let v: Value = contract
        .view("get_status")
        .args_json(json!({"invoice_id": "INV-1"}))
        .await?
        .json()?;
    Ok(v.as_str().unwrap().to_string())
}

#[tokio::test]
async fn split_payment_settles_invoice_and_forwards_funds() -> anyhow::Result<()> {
    let (_w, contract, clinic, patient, insurer) = setup().await?;
    create_invoice(&contract, &clinic, &patient, &insurer).await?;
    assert_eq!(status(&contract).await?, "Open");

    settle().await; // let gas refunds from create_invoice land first
    let before = clinic.view_account().await?.balance.as_yoctonear();
    let contract_before = contract.view_account().await?.balance.as_yoctonear();

    let res = patient
        .call(contract.id(), "pay_share")
        .args_json(json!({"invoice_id": "INV-1", "share_index": 0}))
        .deposit(NearToken::from_yoctonear(NEAR))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert!(
        res.logs()
            .iter()
            .any(|l| l.contains("EVENT_JSON") && l.contains("share_paid")),
        "receipt event missing"
    );
    assert_eq!(status(&contract).await?, "PartiallyPaid");

    insurer
        .call(contract.id(), "pay_share")
        .args_json(json!({"invoice_id": "INV-1", "share_index": 1}))
        .deposit(NearToken::from_yoctonear(4 * NEAR))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(status(&contract).await?, "Paid");

    settle().await;
    let after = clinic.view_account().await?.balance.as_yoctonear();
    assert_eq!(
        after - before,
        5 * NEAR,
        "clinic must receive the full 5 NEAR"
    );

    // The contract keeps nothing: its balance only moves by gas rewards, never by payments.
    let contract_after = contract.view_account().await?.balance.as_yoctonear();
    assert!(
        contract_after.abs_diff(contract_before) < NEAR / 10,
        "contract must not hold payments"
    );
    Ok(())
}

#[tokio::test]
async fn wrong_payer_and_wrong_amount_are_rejected() -> anyhow::Result<()> {
    let (_w, contract, clinic, patient, insurer) = setup().await?;
    create_invoice(&contract, &clinic, &patient, &insurer).await?;

    // insurer tries to pay the patient's share
    let r = insurer
        .call(contract.id(), "pay_share")
        .args_json(json!({"invoice_id": "INV-1", "share_index": 0}))
        .deposit(NearToken::from_yoctonear(NEAR))
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_failure());

    // patient attaches the wrong amount
    let r = patient
        .call(contract.id(), "pay_share")
        .args_json(json!({"invoice_id": "INV-1", "share_index": 0}))
        .deposit(NearToken::from_yoctonear(NEAR / 2))
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_failure());
    assert_eq!(status(&contract).await?, "Open");
    Ok(())
}

#[tokio::test]
async fn refund_sends_money_back_to_the_payer() -> anyhow::Result<()> {
    let (_w, contract, clinic, patient, insurer) = setup().await?;
    create_invoice(&contract, &clinic, &patient, &insurer).await?;

    patient
        .call(contract.id(), "pay_share")
        .args_json(json!({"invoice_id": "INV-1", "share_index": 0}))
        .deposit(NearToken::from_yoctonear(NEAR))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    settle().await;
    let patient_before = patient.view_account().await?.balance.as_yoctonear();
    let res = clinic
        .call(contract.id(), "refund_share")
        .args_json(json!({"invoice_id": "INV-1", "share_index": 0}))
        .deposit(NearToken::from_yoctonear(NEAR))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert!(res.logs().iter().any(|l| l.contains("share_refunded")));
    settle().await;
    let patient_after = patient.view_account().await?.balance.as_yoctonear();
    assert_eq!(patient_after - patient_before, NEAR);

    let inv: Value = contract
        .view("get_invoice")
        .args_json(json!({"invoice_id": "INV-1"}))
        .await?
        .json()?;
    assert_eq!(inv["shares"][0]["state"], "Refunded");
    Ok(())
}

#[tokio::test]
async fn failed_forward_reverts_the_payment_and_refunds_the_payer() -> anyhow::Result<()> {
    let (_w, contract, clinic, patient, insurer) = setup().await?;
    create_invoice(&contract, &clinic, &patient, &insurer).await?;

    // The clinic account disappears, so forwarding the payment must fail.
    clinic
        .clone()
        .delete_account(insurer.id())
        .await?
        .into_result()?;

    let before = patient.view_account().await?.balance.as_yoctonear();
    let _ = patient
        .call(contract.id(), "pay_share")
        .args_json(json!({"invoice_id": "INV-1", "share_index": 0}))
        .deposit(NearToken::from_yoctonear(NEAR))
        .max_gas()
        .transact()
        .await?;
    let after = patient.view_account().await?.balance.as_yoctonear();

    let inv: Value = contract
        .view("get_invoice")
        .args_json(json!({"invoice_id": "INV-1"}))
        .await?
        .json()?;
    assert_eq!(inv["shares"][0]["state"], "Open", "share must be reopened");
    // Payer only lost gas, not the 1 NEAR.
    assert!(
        before - after < NEAR / 10,
        "payer must get the deposit back (lost {})",
        before - after
    );
    Ok(())
}
