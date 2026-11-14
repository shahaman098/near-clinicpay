//! Cross-chain delivery stand-in: what NEAR Intents (1Click) does to ClinicPay.
//!
//! With `customRecipientMsg`, intents.near withdraws via `ft_transfer_call` and can
//! attach as little as 50 Tgas (the verifier's floor). These tests use a stand-in
//! account that holds the test token and calls exactly like that, so the gas floor
//! and the rollback path are proven on a real node before the docs claim support.
//!
//! Case (e) is the gate: with the clinic not registered on the token, a 50 Tgas
//! delivery must roll back, leave the share Open and return the tokens.

use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use std::process::Command;

const USD: u128 = 1_000_000;
const FLOOR_TGAS: u64 = 50;
/// intents.near refuses a `ft_transfer_call` withdrawal below this (FT_TRANSFER_CALL_GAS_MIN).
const HARD_MIN_TGAS: u64 = 30;

/// Build each wasm once per test binary: tests run in parallel, and two `cargo build`s
/// racing on the same output can leave one test reading a file that is being replaced.
fn build(manifest: &str, wasm: &str) -> Vec<u8> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap();
    cache
        .entry(wasm.to_string())
        .or_insert_with(|| build_uncached(manifest, wasm))
        .clone()
}

fn build_uncached(manifest: &str, wasm: &str) -> Vec<u8> {
    let status = Command::new("cargo")
        .args(["build", "--manifest-path", manifest, "--target", "wasm32-unknown-unknown", "--release"])
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
    intents: Account,
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

async fn balance(token: &Contract, who: &str) -> anyhow::Result<u128> {
    let v: String = token.view("ft_balance_of").args_json(json!({"account_id": who})).await?.json()?;
    Ok(v.parse()?)
}

async fn state(env: &Env, id: &str, i: usize) -> anyhow::Result<String> {
    let v: Value = env.pay.view("get_invoice").args_json(json!({"invoice_id": id})).await?.json()?;
    Ok(v["shares"][i]["state"].as_str().unwrap().to_string())
}

async fn setup(register_clinic: bool) -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let pay = worker
        .dev_deploy(&build("Cargo.toml", "target/wasm32-unknown-unknown/release/clinicpay.wasm"))
        .await?;
    pay.call("new").transact().await?.into_result()?;
    let token = worker
        .dev_deploy(&build(
            "../test-token/Cargo.toml",
            "../test-token/target/wasm32-unknown-unknown/release/test_token.wasm",
        ))
        .await?;
    token
        .call("new")
        .args_json(json!({"owner_id": token.id(), "total_supply": (1_000_000 * USD).to_string(), "decimals": 6, "symbol": "tUSDC"}))
        .transact()
        .await?
        .into_result()?;
    let clinic = worker.dev_create_account().await?;
    let intents = worker.dev_create_account().await?;
    for who in [pay.id().as_str(), intents.id().as_str()] {
        register(&token, who).await?;
    }
    if register_clinic {
        register(&token, clinic.id().as_str()).await?;
    }
    token
        .as_account()
        .call(token.id(), "ft_transfer")
        .args_json(json!({"receiver_id": intents.id(), "amount": (100 * USD).to_string()}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    clinic
        .call(pay.id(), "create_invoice")
        .args_json(json!({
            "id": "X-1",
            "memo": "cross-chain stand-in",
            "lines": [{"description": "Visit", "amount": (50 * USD).to_string()}],
            "shares": [
                {"label": "Patient (open)", "payer": null, "amount": (10 * USD).to_string()},
                {"label": "Insurer (named)", "payer": clinic.id(), "amount": (40 * USD).to_string()}
            ],
            "due_ms": null,
            "token": token.id()
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(Env { _worker: worker, pay, token, clinic, intents })
}

fn msg(id: &str, share: u32) -> String {
    json!({"invoice_id": id, "share_index": share}).to_string()
}

async fn deliver(env: &Env, share: u32, gas: u64) -> anyhow::Result<bool> {
    let r = env
        .intents
        .call(env.token.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": env.pay.id(), "amount": (10 * USD).to_string(), "msg": msg("X-1", share)}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(gas))
        .transact()
        .await?;
    Ok(r.is_success())
}

#[tokio::test]
async fn a_delivery_at_the_50_tgas_floor_settles_an_open_share() -> anyhow::Result<()> {
    let env = setup(true).await?;
    let before = balance(&env.token, env.intents.id().as_str()).await?;
    assert!(deliver(&env, 0, FLOOR_TGAS).await?, "50 Tgas delivery failed");
    assert_eq!(state(&env, "X-1", 0).await?, "Paid");
    assert_eq!(balance(&env.token, env.clinic.id().as_str()).await?, 10 * USD);
    assert_eq!(balance(&env.token, env.pay.id().as_str()).await?, 0);
    assert_eq!(balance(&env.token, env.intents.id().as_str()).await?, before - 10 * USD);
    Ok(())
}

#[tokio::test]
async fn named_share_is_returned_not_lost() -> anyhow::Result<()> {
    let env = setup(true).await?;
    let before = balance(&env.token, env.intents.id().as_str()).await?;
    let _ = deliver(&env, 1, FLOOR_TGAS).await?; // made by the stand-in, not the named payer
    assert_eq!(state(&env, "X-1", 1).await?, "Open");
    assert_eq!(balance(&env.token, env.intents.id().as_str()).await?, before, "tokens must come back");
    assert_eq!(balance(&env.token, env.pay.id().as_str()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn duplicate_delivery_is_returned() -> anyhow::Result<()> {
    let env = setup(true).await?;
    assert!(deliver(&env, 0, FLOOR_TGAS).await?);
    let after_paid = balance(&env.token, env.intents.id().as_str()).await?;
    let _ = deliver(&env, 0, FLOOR_TGAS).await?;
    assert_eq!(balance(&env.token, env.intents.id().as_str()).await?, after_paid, "second delivery refunded");
    assert_eq!(balance(&env.token, env.pay.id().as_str()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn failed_delivery_at_the_floor_rolls_back() -> anyhow::Result<()> {
    // Both the verifier's default (50) and its hard minimum (30).
    for gas in [FLOOR_TGAS, HARD_MIN_TGAS] {
        let env = setup(false).await?; // clinic not registered on the token
        let before = balance(&env.token, env.intents.id().as_str()).await?;
        let _ = deliver(&env, 0, gas).await?;
        assert_eq!(state(&env, "X-1", 0).await?, "Open", "share must reopen at {gas} Tgas");
        assert_eq!(balance(&env.token, env.intents.id().as_str()).await?, before, "payer refunded at {gas} Tgas");
        assert_eq!(balance(&env.token, env.pay.id().as_str()).await?, 0);
    }
    Ok(())
}

/// Records the lowest attached gas that still settles. Every attempt uses a fresh
/// open share, so one failure cannot poison the next.
#[tokio::test]
async fn gas_sweep_reports_the_lowest_settling_delivery() -> anyhow::Result<()> {
    let env = setup(true).await?;
    let mut settled = Vec::new();
    for (i, g) in [50u64, 45, 40, 35, 30, 25, 20].iter().enumerate() {
        // Each attempt needs its own open share; rebuild the invoice with 7 open shares.
        let id = format!("SWEEP-{}", i);
        env.clinic
            .call(env.pay.id(), "create_invoice")
            .args_json(json!({
                "id": id, "memo": "sweep",
                "lines": [{"description": "Visit", "amount": (10 * USD).to_string()}],
                "shares": [{"label": "Open", "payer": null, "amount": (10 * USD).to_string()}],
                "due_ms": null, "token": env.token.id()
            }))
            .transact()
            .await?
            .into_result()?;
        // `ft_transfer_call` itself succeeds even when ft_on_transfer runs out of gas
        // and the tokens bounce back, so "settled" means the share is Paid, not that
        // the transaction succeeded.
        let _ = env
            .intents
            .call(env.token.id(), "ft_transfer_call")
            .args_json(json!({"receiver_id": env.pay.id(), "amount": (10 * USD).to_string(), "msg": msg(&id, 0)}))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(*g))
            .transact()
            .await?;
        let ok = state(&env, &id, 0).await? == "Paid";
        assert_eq!(balance(&env.token, env.pay.id().as_str()).await?, 0, "ClinicPay holds nothing at {g} Tgas");
        eprintln!("gas sweep: {} Tgas -> {}", g, if ok { "settled" } else { "failed" });
        if ok {
            settled.push(*g);
        }
    }
    assert!(settled.contains(&FLOOR_TGAS), "50 Tgas must settle");
    assert!(settled.contains(&HARD_MIN_TGAS), "30 Tgas (the verifier's hard minimum) must settle");
    eprintln!("lowest settling delivery: {} Tgas", settled.iter().min().unwrap());
    Ok(())
}

/// Direct payers are not bound by the verifier's 30 Tgas minimum, so the rollback must
/// hold at any gas. With the clinic unregistered every forward fails; at each level the
/// share must stay Open, the sender must have every token back and ClinicPay must hold 0.
#[tokio::test]
async fn rollback_holds_at_every_gas_level() -> anyhow::Result<()> {
    let env = setup(false).await?;
    let before = balance(&env.token, env.intents.id().as_str()).await?;
    for gas in 15..=50u64 {
        let _ = deliver(&env, 0, gas).await?;
        assert_eq!(state(&env, "X-1", 0).await?, "Open", "share must stay Open at {gas} Tgas");
        assert_eq!(balance(&env.token, env.intents.id().as_str()).await?, before, "sender refunded at {gas} Tgas");
        assert_eq!(balance(&env.token, env.pay.id().as_str()).await?, 0, "ClinicPay holds 0 at {gas} Tgas");
    }
    Ok(())
}

/// The clinic's refund path shares the lowered forward/callback gas. At every level a
/// refund either completes (share Refunded, payer repaid) or bounces back whole (share
/// still Paid, clinic keeps the tokens); ClinicPay never holds anything either way.
#[tokio::test]
async fn refund_is_all_or_nothing_at_every_gas_level() -> anyhow::Result<()> {
    let env = setup(true).await?;
    let mut lowest = None;
    for gas in 15..=50u64 {
        let id = format!("R-{gas}");
        env.clinic
            .call(env.pay.id(), "create_invoice")
            .args_json(json!({
                "id": id, "memo": "refund sweep",
                "lines": [{"description": "Visit", "amount": (10 * USD).to_string()}],
                "shares": [{"label": "Open", "payer": null, "amount": (10 * USD).to_string()}],
                "due_ms": null, "token": env.token.id()
            }))
            .transact()
            .await?
            .into_result()?;
        // Top the stand-in up: a refund that bounces leaves its 10 with the clinic.
        env.token
            .call("ft_transfer")
            .args_json(json!({"receiver_id": env.intents.id(), "amount": (10 * USD).to_string()}))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .into_result()?;
        let _ = env
            .intents
            .call(env.token.id(), "ft_transfer_call")
            .args_json(json!({"receiver_id": env.pay.id(), "amount": (10 * USD).to_string(), "msg": msg(&id, 0)}))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(50))
            .transact()
            .await?;
        assert_eq!(state(&env, &id, 0).await?, "Paid");
        let payer_before = balance(&env.token, env.intents.id().as_str()).await?;
        let clinic_before = balance(&env.token, env.clinic.id().as_str()).await?;
        let refund = json!({"invoice_id": id, "share_index": 0, "action": "refund"}).to_string();
        let _ = env
            .clinic
            .call(env.token.id(), "ft_transfer_call")
            .args_json(json!({"receiver_id": env.pay.id(), "amount": (10 * USD).to_string(), "msg": refund}))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(gas))
            .transact()
            .await?;
        let s = state(&env, &id, 0).await?;
        let payer = balance(&env.token, env.intents.id().as_str()).await?;
        let clinic = balance(&env.token, env.clinic.id().as_str()).await?;
        match s.as_str() {
            "Refunded" => {
                assert_eq!(payer, payer_before + 10 * USD, "payer repaid at {gas} Tgas");
                assert_eq!(clinic, clinic_before - 10 * USD, "clinic paid out at {gas} Tgas");
                lowest.get_or_insert(gas);
            }
            "Paid" => {
                assert_eq!(payer, payer_before, "payer untouched at {gas} Tgas");
                assert_eq!(clinic, clinic_before, "clinic kept its tokens at {gas} Tgas");
            }
            other => panic!("unexpected state {other} at {gas} Tgas"),
        }
        assert_eq!(balance(&env.token, env.pay.id().as_str()).await?, 0, "ClinicPay holds 0 at {gas} Tgas");
    }
    eprintln!("lowest completing refund: {:?} Tgas", lowest);
    assert!(lowest.is_some_and(|g| g <= 30), "a refund must complete by 30 Tgas");
    Ok(())
}
