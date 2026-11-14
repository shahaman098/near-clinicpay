//! The deployment and clinic tools (`ops/deploy.mjs`, `ops/clinic.mjs`) run as real
//! processes against a local NEAR sandbox node: deploy + init ClinicPay to an empty
//! account with our own transaction signing, then create and cancel an invoice as a
//! clinic. This is the same path a testnet deployment takes, minus the network.

use near_workspaces::Account;
use serde_json::{json, Value};
use std::process::Command;

fn build_wasm() {
    let status = Command::new("cargo")
        .args(["build", "--target", "wasm32-unknown-unknown", "--release"])
        .status()
        .expect("cargo build failed to start");
    assert!(status.success(), "wasm build failed");
}

fn node(script: &str, args: &[&str], who: &str, account: &Account) -> (i32, String) {
    let out = Command::new("node")
        .current_dir("..")
        .arg(script)
        .args(args)
        .env(format!("{who}_ACCOUNT_ID"), account.id().as_str())
        .env(
            format!("{who}_PRIVATE_KEY"),
            account.secret_key().to_string(),
        )
        .output()
        .expect("node failed to start");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!stderr.contains("ed25519:"), "a key leaked to stderr");
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(!stdout.contains("ed25519:"), "a key leaked to stdout");
    if out.status.code() != Some(0) {
        eprintln!("{script} stderr: {stderr}");
    }
    (out.status.code().unwrap_or(-1), stdout.trim().to_string())
}

#[tokio::test]
async fn deploy_then_create_and_cancel_an_invoice_with_the_ops_tools() -> anyhow::Result<()> {
    build_wasm();
    let worker = near_workspaces::sandbox().await?;
    let rpc = worker.rpc_addr();
    let target = worker.dev_create_account().await?;
    let clinic = worker.dev_create_account().await?;

    let (code, out) = node("ops/deploy.mjs", &["--rpc", &rpc], "DEPLOY", &target);
    assert_eq!(code, 0, "{out}");
    let r: Value = serde_json::from_str(&out)?;
    assert_eq!(r["ok"], true);
    assert_eq!(r["contract"], target.id().as_str());

    let (code, out) = node(
        "ops/clinic.mjs",
        &[
            "create",
            "--contract",
            target.id().as_str(),
            "--rpc",
            &rpc,
            "--id",
            "OPS-1",
            "--memo",
            "GP visit",
            "--line",
            "Consultation=2",
            "--line",
            "Blood panel=3",
            "--share",
            "Patient co-pay=1",
            "--share",
            "Insurer=4",
        ],
        "CLINIC",
        &clinic,
    );
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("invoice_created"), "{out}");

    let inv: Value = worker
        .view(target.id(), "get_invoice")
        .args_json(json!({"invoice_id": "OPS-1"}))
        .await?
        .json()?;
    assert_eq!(inv["payee"], clinic.id().as_str());
    assert_eq!(inv["shares"][1]["amount"], "4000000000000000000000000");

    let (code, out) = node(
        "ops/clinic.mjs",
        &[
            "cancel",
            "--contract",
            target.id().as_str(),
            "--rpc",
            &rpc,
            "--id",
            "OPS-1",
        ],
        "CLINIC",
        &clinic,
    );
    assert_eq!(code, 0, "{out}");
    let status: Value = worker
        .view(target.id(), "get_status")
        .args_json(json!({"invoice_id": "OPS-1"}))
        .await?
        .json()?;
    assert_eq!(status, "Cancelled");

    // Upgrading the code without re-initialising keeps the state.
    let (code, out) = node(
        "ops/deploy.mjs",
        &["--rpc", &rpc, "--no-init"],
        "DEPLOY",
        &target,
    );
    assert_eq!(code, 0, "{out}");
    let inv: Value = worker
        .view(target.id(), "get_invoice")
        .args_json(json!({"invoice_id": "OPS-1"}))
        .await?
        .json()?;
    assert_eq!(inv["id"], "OPS-1");

    // A clinic error comes back with the contract's own message.
    let (code, out) = node(
        "ops/clinic.mjs",
        &[
            "cancel",
            "--contract",
            target.id().as_str(),
            "--rpc",
            &rpc,
            "--id",
            "OPS-1",
        ],
        "CLINIC",
        &clinic,
    );
    assert_eq!(code, 1);
    assert!(out.contains("already cancelled"), "{out}");
    Ok(())
}

/// `clinic.mjs register` pays storage on the token for ClinicPay and the clinic, is
/// harmless to run twice, and leaves a token invoice created with the same tool payable.
#[tokio::test]
async fn register_then_a_token_invoice_settles_with_the_ops_tools() -> anyhow::Result<()> {
    use near_workspaces::types::NearToken;
    build_wasm();
    let status = Command::new("cargo")
        .args(["build", "--manifest-path", "../test-token/Cargo.toml", "--target", "wasm32-unknown-unknown", "--release"])
        .status()?;
    assert!(status.success(), "test-token build failed");
    let worker = near_workspaces::sandbox().await?;
    let rpc = worker.rpc_addr();
    let target = worker.dev_create_account().await?;
    let clinic = worker.dev_create_account().await?;
    let patient = worker.dev_create_account().await?;
    let token = worker
        .dev_deploy(&std::fs::read("../test-token/target/wasm32-unknown-unknown/release/test_token.wasm")?)
        .await?;
    token
        .call("new")
        .args_json(json!({"owner_id": token.id(), "total_supply": "1000000000000", "decimals": 6, "symbol": "tUSDC"}))
        .transact()
        .await?
        .into_result()?;
    let (code, out) = node("ops/deploy.mjs", &["--rpc", &rpc], "DEPLOY", &target);
    assert_eq!(code, 0, "{out}");

    let reg = ["register", "--contract", target.id().as_str(), "--token", token.id().as_str(), "--rpc", &rpc];
    let (code, out) = node("ops/clinic.mjs", &reg, "CLINIC", &clinic);
    assert_eq!(code, 0, "{out}");
    let r: Value = serde_json::from_str(&out)?;
    assert_eq!(r["results"][0]["registered"], "now", "{out}");
    assert_eq!(r["results"][1]["registered"], "now", "{out}");
    let (code, out) = node("ops/clinic.mjs", &reg, "CLINIC", &clinic);
    assert_eq!(code, 0, "{out}");
    let r: Value = serde_json::from_str(&out)?;
    assert_eq!(r["results"][0]["registered"], "already", "{out}");
    assert_eq!(r["results"][1]["registered"], "already", "{out}");

    let (code, out) = node(
        "ops/clinic.mjs",
        &[
            "create", "--contract", target.id().as_str(), "--rpc", &rpc, "--id", "OPS-T",
            "--token", token.id().as_str(), "--decimals", "6",
            "--line", "Consultation=10", "--share", "Patient co-pay=10",
        ],
        "CLINIC",
        &clinic,
    );
    assert_eq!(code, 0, "{out}");

    // The patient pays with the token; it must land with the clinic.
    patient
        .call(token.id(), "storage_deposit")
        .args_json(json!({"account_id": patient.id(), "registration_only": true}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    token
        .call("ft_transfer")
        .args_json(json!({"receiver_id": patient.id(), "amount": "10000000"}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    patient
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": target.id(), "amount": "10000000",
            "msg": json!({"invoice_id": "OPS-T", "share_index": 0}).to_string()}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let st: Value = worker.view(target.id(), "get_status").args_json(json!({"invoice_id": "OPS-T"})).await?.json()?;
    assert_eq!(st, "Paid");
    let held: String = token.view("ft_balance_of").args_json(json!({"account_id": clinic.id()})).await?.json()?;
    assert_eq!(held, "10000000");
    Ok(())
}
