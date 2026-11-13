//! Local demo: start a NEAR sandbox node, deploy ClinicPay, run a real split-payment
//! flow, then keep the node up so the CLI and the invoice page can read live chain state.
//!
//!   cd contract && cargo run --example demo
//!
//! Ctrl-C to stop. Sandbox accounts and balances are local and disposable.

use near_workspaces::types::NearToken;
use serde_json::json;
use std::process::Command;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let st = Command::new("cargo")
        .args(["build", "--target", "wasm32-unknown-unknown", "--release"])
        .status()?;
    anyhow::ensure!(st.success(), "wasm build failed");
    let wasm = std::fs::read("target/wasm32-unknown-unknown/release/clinicpay.wasm")?;

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

    println!("Read it back (new terminal, from the repo root):");
    println!("  node cli/clinicpay.mjs status --contract {} --id INV-2026-0042 --rpc {rpc}", contract.id());
    println!("  node cli/clinicpay.mjs export --contract {} --clinic {} --rpc {rpc}", contract.id(), clinic.id());
    println!("\nInvoice page (serve the repo, then open):");
    println!("  python3 -m http.server 8080   ->   http://localhost:8080/web/invoice.html?contract={}&id=INV-2026-0042&rpc={rpc}", contract.id());
    println!("\nCtrl-C to stop the sandbox.");
    tokio::signal::ctrl_c().await?;
    Ok(())
}
