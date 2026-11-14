//! End-to-end tests for gasless payments (NEP-366 meta transactions).
//!
//! A local NEAR sandbox node runs ClinicPay and a 6-decimal test token. The payer
//! signs a delegate action with `relayer/payer.mjs`; the relayer checks it and
//! submits it with `relayer/relayer.mjs submit`, paying the gas. The tests then read
//! real balances: the payer spends exactly the share (or 1 yoctoNEAR for a token
//! payment) and no gas, and the relayer refuses anything that is not a ClinicPay call.

use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use std::process::Command;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const USD: u128 = 1_000_000;

fn build(manifest: &str, wasm: &str) -> Vec<u8> {
    let status = Command::new("cargo")
        .args(["build", "--manifest-path", manifest, "--target", "wasm32-unknown-unknown", "--release"])
        .status()
        .expect("cargo build failed to start");
    assert!(status.success(), "wasm build failed for {manifest}");
    std::fs::read(wasm).unwrap_or_else(|_| panic!("wasm missing: {wasm}"))
}

struct Env {
    worker: Worker<Sandbox>,
    pay: Contract,
    token: Contract,
    clinic: Account,
    patient: Account,
    insurer: Account,
    relayer: Account,
}

async fn setup() -> anyhow::Result<Env> {
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
    let patient = worker.dev_create_account().await?;
    let insurer = worker.dev_create_account().await?;
    let relayer = worker.dev_create_account().await?;
    for who in [pay.id(), clinic.id(), patient.id(), insurer.id()] {
        token
            .as_account()
            .call(token.id(), "storage_deposit")
            .args_json(json!({"account_id": who, "registration_only": true}))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await?
            .into_result()?;
    }
    token
        .as_account()
        .call(token.id(), "ft_transfer")
        .args_json(json!({"receiver_id": patient.id(), "amount": (10 * USD).to_string()}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    for (id, tok, unit) in [("G-NEAR", None, NEAR), ("G-USDC", Some(token.id().to_string()), USD)] {
        clinic
            .call(pay.id(), "create_invoice")
            .args_json(json!({
                "id": id, "memo": "gasless",
                "lines": [{"description": "Visit", "amount": (5 * unit).to_string()}],
                "shares": [
                    {"label": "Patient co-pay", "payer": patient.id(), "amount": unit.to_string()},
                    {"label": "Insurer", "payer": insurer.id(), "amount": (4 * unit).to_string()}
                ],
                "due_ms": null, "token": tok
            }))
            .transact()
            .await?
            .into_result()?;
    }
    Ok(Env { worker, pay, token, clinic, patient, insurer, relayer })
}

/// Run a relayer/*.mjs script from the repo root with the given key in the environment.
fn node(script: &str, args: &[&str], who: &str, account: &Account) -> (i32, String) {
    let out = Command::new("node")
        .current_dir("..")
        .arg(format!("relayer/{script}"))
        .args(args)
        .env(format!("{who}_ACCOUNT_ID"), account.id().as_str())
        .env(format!("{who}_PRIVATE_KEY"), account.secret_key().to_string())
        .output()
        .expect("node failed to start");
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !stderr.is_empty() {
        eprintln!("{script} stderr: {stderr}");
    }
    (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn sign(env: &Env, payer: &Account, extra: &[&str]) -> String {
    let rpc = env.worker.rpc_addr();
    // extra[0] is the subcommand (pay | adjudicate) and must come first.
    let mut args = vec![extra[0], "--contract", env.pay.id().as_str(), "--rpc", rpc.as_str()];
    args.extend_from_slice(&extra[1..]);
    let (code, out) = node("payer.mjs", &args, "PAYER", payer);
    assert_eq!(code, 0, "payer.mjs failed: {out}");
    out
}

fn submit(env: &Env, signed: &str) -> (i32, Value) {
    let rpc = env.worker.rpc_addr();
    let (code, out) = node(
        "relayer.mjs",
        &["submit", "--contract", env.pay.id().as_str(), "--token", env.token.id().as_str(), "--rpc", rpc.as_str(), signed],
        "RELAYER",
        &env.relayer,
    );
    (code, serde_json::from_str(&out).unwrap_or_else(|_| panic!("relayer printed non-JSON: {out}")))
}

/// Gas refunds and forwarded transfers land a block or two after a transaction
/// returns, so wait before comparing NEAR balances.
async fn settle() {
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
}

async fn near_of(a: &Account) -> anyhow::Result<u128> {
    Ok(a.view_account().await?.balance.as_yoctonear())
}

async fn usd_of(env: &Env, who: &str) -> anyhow::Result<u128> {
    let v: String = env.token.view("ft_balance_of").args_json(json!({"account_id": who})).await?.json()?;
    Ok(v.parse()?)
}

async fn share_state(env: &Env, id: &str, i: usize) -> anyhow::Result<String> {
    let v: Value = env.pay.view("get_invoice").args_json(json!({"invoice_id": id})).await?.json()?;
    Ok(v["shares"][i]["state"].as_str().unwrap().to_string())
}

#[tokio::test]
async fn gasless_stablecoin_payment_costs_the_payer_no_near() -> anyhow::Result<()> {
    let env = setup().await?;
    settle().await;
    let (p0, r0) = (near_of(&env.patient).await?, near_of(&env.relayer).await?);

    let signed = sign(&env, &env.patient, &["pay", "--id", "G-USDC", "--share", "0"]);
    let (code, r) = submit(&env, &signed);
    assert_eq!(code, 0, "{r}");
    assert_eq!(r["ok"], true);
    assert!(r["logs"].as_array().unwrap().iter().any(|l| l.as_str().unwrap().contains("share_paid")));
    assert_eq!(share_state(&env, "G-USDC", 0).await?, "Paid");

    // The named-payer rule still holds: the contract saw the patient, not the relayer.
    let v: Value = env.pay.view("get_invoice").args_json(json!({"invoice_id": "G-USDC"})).await?.json()?;
    assert_eq!(v["shares"][0]["paid_by"], env.patient.id().as_str());

    settle().await;
    assert_eq!(near_of(&env.patient).await?, p0, "payer spent no NEAR at all");
    assert_eq!(usd_of(&env, env.patient.id().as_str()).await?, 9 * USD, "payer spent exactly the 1 tUSDC share");
    assert_eq!(usd_of(&env, env.clinic.id().as_str()).await?, USD, "clinic received exactly the share");
    assert_eq!(usd_of(&env, env.pay.id().as_str()).await?, 0, "ClinicPay holds nothing");
    assert!(near_of(&env.relayer).await? < r0, "relayer paid the gas");
    Ok(())
}

#[tokio::test]
async fn relayer_refuses_an_adjudication_the_contract_would_reject() -> anyhow::Result<()> {
    let env = setup().await?;
    let signed = sign(&env, &env.patient, &["pay", "--id", "G-USDC", "--share", "0"]);
    let (code, r) = submit(&env, &signed);
    assert_eq!(code, 0, "{r}");
    settle().await;
    let (i0, r0) = (near_of(&env.insurer).await?, near_of(&env.relayer).await?);

    // Share 0 is already paid, so the residual cannot move there. The relayer mirrors
    // the contract's rule and refuses before building a transaction: no gas is spent.
    let approved = (3 * USD).to_string();
    let signed = sign(
        &env,
        &env.insurer,
        &["adjudicate", "--id", "G-USDC", "--share", "1", "--approved", &approved, "--reason", "CO-45 fee schedule", "--move-to", "0"],
    );
    let (code, r) = submit(&env, &signed);
    assert_eq!(code, 3, "{r}");
    assert!(r["error"].as_str().unwrap().contains("move_to share must be open"), "{r}");
    settle().await;
    assert_eq!(near_of(&env.insurer).await?, i0, "insurer spent nothing");
    assert_eq!(near_of(&env.relayer).await?, r0, "relayer spent nothing");
    let v: Value = env.pay.view("get_invoice").args_json(json!({"invoice_id": "G-USDC"})).await?.json()?;
    assert!(v["shares"][1]["adjudication"].is_null());
    Ok(())
}

#[tokio::test]
async fn http_relayer_serves_a_gasless_payment() -> anyhow::Result<()> {
    use std::io::{BufRead, BufReader};
    let env = setup().await?;
    let rpc = env.worker.rpc_addr();
    let mut child = Command::new("node")
        .current_dir("..")
        .args(["relayer/relayer.mjs", "serve", "--contract", env.pay.id().as_str(), "--token", env.token.id().as_str(), "--rpc", rpc.as_str(), "--port", "0"])
        .env("RELAYER_ACCOUNT_ID", env.relayer.id().as_str())
        .env("RELAYER_PRIVATE_KEY", env.relayer.secret_key().to_string())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    let mut line = String::new();
    BufReader::new(child.stderr.take().unwrap()).read_line(&mut line)?;
    let port = line.trim().split("listening on port ").nth(1).and_then(|r| r.split(' ').next()).map(str::to_string);
    let result = async {
        let port = port.ok_or_else(|| anyhow::anyhow!("relayer did not start: {line}"))?;
        settle().await;
        let p0 = near_of(&env.patient).await?;
        let url = format!("http://127.0.0.1:{port}");
        let (code, out) = node(
            "payer.mjs",
            &["pay", "--contract", env.pay.id().as_str(), "--rpc", rpc.as_str(), "--id", "G-USDC", "--share", "0", "--relayer", &url],
            "PAYER",
            &env.patient,
        );
        assert_eq!(code, 0, "{out}");
        let r: Value = serde_json::from_str(&out)?;
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(share_state(&env, "G-USDC", 0).await?, "Paid");
        settle().await;
        assert_eq!(near_of(&env.patient).await?, p0, "payer spent no NEAR");
        assert_eq!(usd_of(&env, env.clinic.id().as_str()).await?, USD);
        anyhow::Ok(())
    }
    .await;
    let _ = child.kill();
    result
}

#[tokio::test]
async fn insurer_adjudicates_gaslessly_before_anyone_pays() -> anyhow::Result<()> {
    let env = setup().await?;
    settle().await;
    let i0 = near_of(&env.insurer).await?;
    let approved = (3 * NEAR).to_string();
    let signed = sign(
        &env,
        &env.insurer,
        &["adjudicate", "--id", "G-NEAR", "--share", "1", "--approved", &approved, "--reason", "CO-45 fee schedule", "--move-to", "0"],
    );
    let (code, r) = submit(&env, &signed);
    assert_eq!(code, 0, "{r}");
    let v: Value = env.pay.view("get_invoice").args_json(json!({"invoice_id": "G-NEAR"})).await?.json()?;
    assert_eq!(v["shares"][0]["amount"], (2 * NEAR).to_string());
    assert_eq!(v["shares"][1]["adjudication"]["reason"], "CO-45 fee schedule");
    settle().await;
    assert_eq!(near_of(&env.insurer).await?, i0, "insurer spent nothing");
    Ok(())
}

#[tokio::test]
async fn relayer_refuses_calls_it_should_not_pay_for() -> anyhow::Result<()> {
    let env = setup().await?;

    // NEAR-priced shares are not relayed: the payer tool refuses to build one, since
    // under NEP-366 the relayer, not the payer, would fund pay_share's deposit.
    let rpc = env.worker.rpc_addr();
    let (code, _) = node(
        "payer.mjs",
        &["pay", "--contract", env.pay.id().as_str(), "--rpc", rpc.as_str(), "--id", "G-NEAR", "--share", "0"],
        "PAYER",
        &env.patient,
    );
    assert_eq!(code, 1);

    settle().await;
    let r0 = near_of(&env.relayer).await?;
    // The patient tries to pay the insurer's named share: refused before any gas is spent.
    // (The insurer's share is 4 tUSDC; give the patient enough so only the payer rule stops it.)
    env.token
        .as_account()
        .call(env.token.id(), "ft_transfer")
        .args_json(json!({"receiver_id": env.patient.id(), "amount": (4 * USD).to_string()}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let forged = sign_as_other(&env, &env.patient, "G-USDC", 1);
    let (code, r) = submit(&env, &forged);
    assert_eq!(code, 3, "{r}");
    assert!(r["error"].as_str().unwrap().contains("named payer"), "{r}");

    // Garbage is refused outright.
    let (code, r) = submit(&env, "bm90IGEgZGVsZWdhdGU=");
    assert_eq!(code, 3, "{r}");
    settle().await;
    assert_eq!(near_of(&env.relayer).await?, r0, "refusals cost the relayer nothing");

    // Resubmitting the same signed delegate is refused by the relayer (the share is
    // already paid), so it cannot pay twice. Its nonce is also spent, so the chain
    // would reject it too.
    let signed = sign(&env, &env.patient, &["pay", "--id", "G-USDC", "--share", "0"]);
    let (code, r) = submit(&env, &signed);
    assert_eq!(code, 0, "{r}");
    let after_first = usd_of(&env, env.patient.id().as_str()).await?;
    let (code, r) = submit(&env, &signed);
    assert_eq!(code, 3, "replay must be refused: {r}");
    assert_eq!(r["refused"], true);
    assert!(r["error"].as_str().unwrap().contains("share is Paid"), "{r}");
    assert_eq!(usd_of(&env, env.patient.id().as_str()).await?, after_first, "a replay moves no money");
    Ok(())
}

/// The patient signs a payment for a share that names someone else. payer.mjs only
/// builds the call; the relayer's live check is what must stop it.
fn sign_as_other(env: &Env, payer: &Account, id: &str, share: u32) -> String {
    let rpc = env.worker.rpc_addr();
    let (code, out) = node(
        "payer.mjs",
        &["pay", "--contract", env.pay.id().as_str(), "--rpc", rpc.as_str(), "--id", id, "--share", &share.to_string()],
        "PAYER",
        payer,
    );
    assert_eq!(code, 0, "payer.mjs failed: {out}");
    out
}
