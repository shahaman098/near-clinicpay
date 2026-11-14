//! Local demo: start a NEAR sandbox node, deploy ClinicPay, run a real split-payment
//! flow, then keep the node up so the CLI and the invoice page can read live chain state.
//!
//! Two invoices are created: one priced in NEAR, one priced in a 6-decimal NEP-141
//! test token standing in for USDC. The patient pays their co-pay on both; the
//! insurer's share stays open so the CLI can show a PartiallyPaid invoice.
//!
//!   cd contract && cargo run --example demo
//!
//! Ctrl-C to stop. Sandbox accounts and balances are local and disposable.

use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use std::process::Command;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const USD: u128 = 1_000_000; // 6 decimals, like USDC

fn build(manifest: &str, wasm: &str) -> anyhow::Result<Vec<u8>> {
    let status = Command::new("cargo")
        .args([
            "build",
            "--manifest-path",
            manifest,
            "--target",
            "wasm32-unknown-unknown",
            "--release",
        ])
        .status()?;
    anyhow::ensure!(status.success(), "wasm build failed for {manifest}");
    Ok(std::fs::read(wasm)?)
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

async fn deploy_token(
    worker: &Worker<Sandbox>,
    wasm: &[u8],
    symbol: &str,
) -> anyhow::Result<Contract> {
    let token = worker.dev_deploy(wasm).await?;
    token
        .call("new")
        .args_json(json!({
            "owner_id": token.id(),
            "total_supply": (1_000_000 * USD).to_string(),
            "decimals": 6,
            "symbol": symbol
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(token)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let wasm = build(
        "Cargo.toml",
        "target/wasm32-unknown-unknown/release/clinicpay.wasm",
    )?;
    let token_wasm = build(
        "../test-token/Cargo.toml",
        "../test-token/target/wasm32-unknown-unknown/release/test_token.wasm",
    )?;

    let worker = near_workspaces::sandbox().await?;
    let rpc = worker.rpc_addr();
    let contract = worker.dev_deploy(&wasm).await?;
    contract.call("new").transact().await?.into_result()?;
    let clinic = worker.dev_create_account().await?;
    let patient = worker.dev_create_account().await?;
    let insurer = worker.dev_create_account().await?;

    println!("sandbox RPC : {rpc}");
    println!("contract    : {}", contract.id());
    println!("clinic      : {}", clinic.id());
    println!("patient     : {}", patient.id());
    println!("insurer     : {}\n", insurer.id());

    // ---- NEAR invoice -------------------------------------------------------
    clinic
        .call(contract.id(), "create_invoice")
        .args_json(json!({
            "id": "INV-2026-0042",
            "memo": "GP visit 12 Nov: consultation + blood panel",
            "lines": [
                {"description": "GP consultation", "amount": (2 * NEAR).to_string()},
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
    println!("1. clinic created INV-2026-0042 (5 NEAR: patient 1 + insurer 4)");

    let r = patient
        .call(contract.id(), "pay_share")
        .args_json(json!({"invoice_id": "INV-2026-0042", "share_index": 0}))
        .deposit(NearToken::from_yoctonear(NEAR))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    for l in r.logs() {
        println!("   on-chain receipt: {l}");
    }
    println!("2. patient paid their 1 NEAR share; insurer's 4 NEAR share is still open\n");

    // ---- stablecoin invoice (local 6-decimal NEP-141 test token) -------------
    let token = deploy_token(&worker, &token_wasm, "tUSDC").await?;
    println!(
        "3. deployed tUSDC (test token, 6 decimals, stands in for USDC): {}",
        token.id()
    );

    for who in [
        contract.id().as_str(),
        clinic.id().as_str(),
        patient.id().as_str(),
        insurer.id().as_str(),
    ] {
        register(&token, who).await?;
    }
    fund(&token, &patient, 10 * USD).await?;
    fund(&token, &insurer, 40 * USD).await?;

    clinic
        .call(contract.id(), "create_invoice")
        .args_json(json!({
            "id": "INV-2026-0043",
            "memo": "GP visit 12 Nov, billed in stablecoin",
            "lines": [{"description": "Consultation + blood panel", "amount": (50 * USD).to_string()}],
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
    println!("4. clinic created INV-2026-0043 (50 tUSDC: patient 10 + insurer 40)");

    let msg: Value = json!({"invoice_id": "INV-2026-0043", "share_index": 0});
    let r = patient
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": contract.id(),
            "amount": (10 * USD).to_string(),
            "msg": msg.to_string()
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    for l in r.logs() {
        println!("   on-chain receipt: {l}");
    }
    println!(
        "5. patient paid 10 tUSDC via ft_transfer_call; insurer's 40 tUSDC share is still open\n"
    );

    // ---- failure path: the clinic cannot receive the token -------------------
    let token2 = deploy_token(&worker, &token_wasm, "tUSDC2").await?;
    println!("6. deployed tUSDC2 and deliberately did NOT register the clinic on it");
    for who in [contract.id().as_str(), patient.id().as_str()] {
        register(&token2, who).await?;
    }
    fund(&token2, &patient, 10 * USD).await?;
    clinic
        .call(contract.id(), "create_invoice")
        .args_json(json!({
            "id": "INV-2026-0044",
            "memo": "Forward fails: clinic not registered on tUSDC2",
            "lines": [{"description": "Consultation", "amount": (10 * USD).to_string()}],
            "shares": [
                {"label": "Patient co-pay", "payer": patient.id(), "amount": (10 * USD).to_string()}
            ],
            "due_ms": null,
            "token": token2.id()
        }))
        .transact()
        .await?
        .into_result()?;

    let before = balance(&token2, patient.id().as_str()).await?;
    let r = patient
        .call(token2.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": contract.id(),
            "amount": (10 * USD).to_string(),
            "msg": json!({"invoice_id": "INV-2026-0044", "share_index": 0}).to_string()
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    for l in r.logs() {
        println!("   on-chain receipt: {l}");
    }
    let after = balance(&token2, patient.id().as_str()).await?;
    let held = balance(&token2, contract.id().as_str()).await?;
    println!(
        "7. forward failed: payment_reverted, the payer is refunded, and the share is Open again \
         (patient {} tUSDC before and {} after; contract holds {})\n",
        before / USD,
        after / USD,
        held / USD
    );

    println!("Read it back (new terminal, from the repo root):");
    println!(
        "  node cli/clinicpay.mjs status --contract {} --id INV-2026-0042 --rpc {rpc}",
        contract.id()
    );
    println!(
        "  node cli/clinicpay.mjs status --contract {} --id INV-2026-0043 --rpc {rpc}",
        contract.id()
    );
    println!(
        "  node cli/clinicpay.mjs export --contract {} --clinic {} --rpc {rpc}",
        contract.id(),
        clinic.id()
    );
    println!("\nInvoice page (serve the repo, then open):");
    println!("  python3 -m http.server 8080   ->   http://localhost:8080/web/invoice.html?contract={}&id=INV-2026-0042&rpc={rpc}", contract.id());
    println!("\nCtrl-C to stop the sandbox.");
    tokio::signal::ctrl_c().await?;
    Ok(())
}
