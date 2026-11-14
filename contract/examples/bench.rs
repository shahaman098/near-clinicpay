//! Gas and storage benchmark for ClinicPay on a local NEAR sandbox node.
//!
//!   cd contract && cargo run --example bench -- [NEAR_USD_RATE] [DATE]
//!
//! Measures gas for: invoice creation, a NEAR payment, a stablecoin payment,
//! adjudication, refund, cancellation, and two relayed (NEP-366) calls. Sums the
//! transaction plus every receipt outcome, converts at the node's gas price, and
//! measures the contract's storage growth per invoice (1e19 yocto per byte).
//! Writes `docs/BENCHMARKS.md`. Pass a NEAR/USD rate to get a USD column; without
//! one the report stays in NEAR and says so.

use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use std::process::Command;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const USD: u128 = 1_000_000;
const YOCTO_PER_BYTE: u128 = 10_000_000_000_000_000_000; // 1e19

struct Env {
    worker: Worker<Sandbox>,
    pay: Contract,
    token: Contract,
    clinic: Account,
    patient: Account,
    insurer: Account,
    relayer: Account,
}

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

async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let pay = worker
        .dev_deploy(&build(
            "Cargo.toml",
            "target/wasm32-unknown-unknown/release/clinicpay.wasm",
        ))
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
    for (who, amount) in [(&patient, 10 * USD), (&insurer, 40 * USD)] {
        token
            .as_account()
            .call(token.id(), "ft_transfer")
            .args_json(json!({"receiver_id": who.id(), "amount": amount.to_string()}))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .into_result()?;
    }
    Ok(Env {
        worker,
        pay,
        token,
        clinic,
        patient,
        insurer,
        relayer,
    })
}

async fn create(env: &Env, id: &str, token: Option<&str>) -> anyhow::Result<()> {
    create_as(env, &env.clinic, id, token).await.map(|_| ())
}

/// Create a 5-unit, two-share invoice as `who`; returns the gas the call burnt.
async fn create_as(
    env: &Env,
    who: &Account,
    id: &str,
    token: Option<&str>,
) -> anyhow::Result<u128> {
    let unit = if token.is_some() { USD } else { NEAR };
    let r = who
        .call(env.pay.id(), "create_invoice")
        .args_json(json!({
            "id": id,
            "memo": "bench",
            "lines": [{"description": "Visit", "amount": (5 * unit).to_string()}],
            "shares": [
                {"label": "Patient co-pay", "payer": env.patient.id(), "amount": unit.to_string()},
                {"label": "Insurer", "payer": env.insurer.id(), "amount": (4 * unit).to_string()}
            ],
            "due_ms": null,
            "token": token
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(r.total_gas_burnt.as_gas() as u128)
}

/// One point on the scale curve: the contract holds `size` invoices in total, of
/// which exactly 2 belong to the target clinic (the rest are one other clinic's).
struct ScaleRow {
    size: u32,
    /// Gas of `list_invoices(target)` sent as a transaction (a view call reports no gas).
    list_gas: u128,
    list_ok: bool,
    /// Gas of the `size`-th `create_invoice`, made by the busy clinic.
    create_gas: u128,
    /// Average storage bytes added per invoice since the previous size.
    bytes_per_invoice: f64,
}

/// Fresh sandbox; grows the contract to each size in turn and measures at each.
/// The target clinic's two invoices come first, so a full scan must walk every
/// other invoice to find them and never reaches the page limit early.
async fn scale(sizes: &[u32]) -> anyhow::Result<Vec<ScaleRow>> {
    let env = setup().await?;
    let busy = env.worker.dev_create_account().await?;
    let mut rows = Vec::new();
    let mut total = 0u32;
    let mut prev_usage = env.worker.view_account(env.pay.id()).await?.storage_usage;
    for &size in sizes {
        let start = total;
        let mut create_gas = 0;
        while total < size {
            let who = if total < 2 { &env.clinic } else { &busy };
            create_gas = create_as(&env, who, &format!("INV-2026-{total:04}"), None).await?;
            total += 1;
        }
        let usage = env.worker.view_account(env.pay.id()).await?.storage_usage;
        let r = env
            .patient
            .call(env.pay.id(), "list_invoices")
            .args_json(json!({"payee": env.clinic.id(), "from_index": null, "limit": null}))
            .max_gas()
            .transact()
            .await?;
        let list_ok = r.is_success();
        let list_gas = r.total_gas_burnt.as_gas() as u128;
        if list_ok {
            let got: Vec<Value> = r.json()?;
            assert_eq!(got.len(), 2, "target clinic must list exactly its 2 invoices");
        }
        rows.push(ScaleRow {
            size,
            list_gas,
            list_ok,
            create_gas,
            bytes_per_invoice: (usage - prev_usage) as f64 / (total - start) as f64,
        });
        prev_usage = usage;
    }
    Ok(rows)
}

const SCAN_BASELINE: &str = "examples/scale_scan_baseline.json";

fn rows_to_json(rows: &[ScaleRow]) -> Value {
    json!(rows.iter().map(|r| json!({
        "size": r.size, "list_gas": r.list_gas.to_string(), "list_ok": r.list_ok,
        "create_gas": r.create_gas.to_string(), "bytes_per_invoice": r.bytes_per_invoice,
    })).collect::<Vec<_>>())
}

fn node(script: &str, args: &[&str], who: &str, account: &Account) -> (i32, String) {
    let out = Command::new("node")
        .current_dir("..")
        .arg(format!("relayer/{script}"))
        .args(args)
        .env(format!("{who}_ACCOUNT_ID"), account.id().as_str())
        .env(
            format!("{who}_PRIVATE_KEY"),
            account.secret_key().to_string(),
        )
        .output()
        .expect("node failed to start");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).trim().to_string(),
    )
}

fn sign(env: &Env, payer: &Account, args: &[&str]) -> String {
    let rpc = env.worker.rpc_addr();
    let mut full = vec![
        args[0],
        "--contract",
        env.pay.id().as_str(),
        "--rpc",
        rpc.as_str(),
    ];
    full.extend_from_slice(&args[1..]);
    let (code, out) = node("payer.mjs", &full, "PAYER", payer);
    assert_eq!(code, 0, "payer.mjs failed: {out}");
    out
}

fn submit(env: &Env, signed: &str) -> Value {
    let rpc = env.worker.rpc_addr();
    let (code, out) = node(
        "relayer.mjs",
        &[
            "submit",
            "--contract",
            env.pay.id().as_str(),
            "--token",
            env.token.id().as_str(),
            "--rpc",
            rpc.as_str(),
            signed,
        ],
        "RELAYER",
        &env.relayer,
    );
    assert_eq!(code, 0, "relayer failed: {out}");
    serde_json::from_str(&out).expect("relayer printed non-JSON")
}

/// Gas burnt for a transaction hash, summed over the tx and all receipts. Cost is
/// derived from this by the caller (gas × gas price), the same as every other row;
/// the RPC's `tokens_burnt` is not used because it is priced per block and does not
/// line up with the gas column.
async fn tx_gas(rpc: &str, hash: &str, account: &str) -> anyhow::Result<u128> {
    let v: Value = reqwest::Client::new()
        .post(rpc)
        .json(&json!({"jsonrpc": "2.0", "id": "bench", "method": "tx", "params": [hash, account]}))
        .send()
        .await?
        .json()
        .await?;
    if let Some(err) = v.get("error") {
        anyhow::bail!("tx {hash}: {err}");
    }
    let result = &v["result"];
    let mut gas = result["transaction_outcome"]["outcome"]["gas_burnt"]
        .as_u64()
        .unwrap_or(0) as u128;
    for r in result["receipts_outcome"].as_array().into_iter().flatten() {
        gas += r["outcome"]["gas_burnt"].as_u64().unwrap_or(0) as u128;
    }
    Ok(gas)
}

fn tgas(gas: u128) -> f64 {
    gas as f64 / 1e12
}

async fn balance(token: &Contract, who: &str) -> anyhow::Result<u128> {
    let v: String = token
        .view("ft_balance_of")
        .args_json(json!({"account_id": who}))
        .await?
        .json()?;
    Ok(v.parse()?)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let rate: Option<f64> = args.get(1).and_then(|s| s.parse().ok());
    let date = args.get(2).cloned().unwrap_or_else(|| "n/a".into());

    let env = setup().await?;
    let gas_price = env.worker.gas_price().await?.as_yoctonear(); // yocto per gas

    // Storage per invoice: measure the contract account around one creation.
    let before = env.worker.view_account(env.pay.id()).await?.storage_usage;
    let r = env
        .clinic
        .call(env.pay.id(), "create_invoice")
        .args_json(json!({
            "id": "B-CREATE", "memo": "bench",
            "lines": [{"description": "Visit", "amount": (5 * NEAR).to_string()}],
            "shares": [
                {"label": "Patient co-pay", "payer": env.patient.id(), "amount": NEAR.to_string()},
                {"label": "Insurer", "payer": env.insurer.id(), "amount": (4 * NEAR).to_string()}
            ],
            "due_ms": null, "token": null
        }))
        .transact()
        .await?
        .into_result()?;
    let create_gas = r.total_gas_burnt;
    let after = env.worker.view_account(env.pay.id()).await?.storage_usage;
    let bytes = after.saturating_sub(before) as u128;

    let mut ops: Vec<(String, u128, u128)> = vec![(
        "create_invoice".into(),
        create_gas.as_gas() as u128,
        create_gas.as_gas() as u128 * gas_price,
    )];

    // NEAR payment.
    create(&env, "B-NEAR", None).await?;
    let r = env
        .patient
        .call(env.pay.id(), "pay_share")
        .args_json(json!({"invoice_id": "B-NEAR", "share_index": 0}))
        .deposit(NearToken::from_yoctonear(NEAR))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    ops.push((
        "pay_share (NEAR)".into(),
        r.total_gas_burnt.as_gas() as u128,
        r.total_gas_burnt.as_gas() as u128 * gas_price,
    ));

    // Stablecoin payment.
    create(&env, "B-TOKEN", Some(env.token.id().as_str())).await?;
    let r = env
        .patient
        .call(env.token.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": env.pay.id(),
            "amount": USD.to_string(),
            "msg": json!({"invoice_id": "B-TOKEN", "share_index": 0}).to_string()
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    ops.push((
        "ft_transfer_call (token)".into(),
        r.total_gas_burnt.as_gas() as u128,
        r.total_gas_burnt.as_gas() as u128 * gas_price,
    ));

    // Adjudication: insurer approves 3 of 4 NEAR, moves 1 to the patient.
    create(&env, "B-ADJ", None).await?;
    let r = env
        .insurer
        .call(env.pay.id(), "adjudicate_share")
        .args_json(json!({"invoice_id": "B-ADJ", "share_index": 1, "approved": (3 * NEAR).to_string(), "reason": "CO-45 fee schedule", "move_to": 0}))
        .transact()
        .await?
        .into_result()?;
    ops.push((
        "adjudicate_share".into(),
        r.total_gas_burnt.as_gas() as u128,
        r.total_gas_burnt.as_gas() as u128 * gas_price,
    ));

    // Refund a paid share (pay first, then clinic refunds).
    create(&env, "B-REF", None).await?;
    env.patient
        .call(env.pay.id(), "pay_share")
        .args_json(json!({"invoice_id": "B-REF", "share_index": 0}))
        .deposit(NearToken::from_yoctonear(NEAR))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let r = env
        .clinic
        .call(env.pay.id(), "refund_share")
        .args_json(json!({"invoice_id": "B-REF", "share_index": 0}))
        .deposit(NearToken::from_yoctonear(NEAR))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    ops.push((
        "refund_share".into(),
        r.total_gas_burnt.as_gas() as u128,
        r.total_gas_burnt.as_gas() as u128 * gas_price,
    ));

    // Cancel an untouched invoice.
    create(&env, "B-CANCEL", None).await?;
    let r = env
        .clinic
        .call(env.pay.id(), "cancel_invoice")
        .args_json(json!({"invoice_id": "B-CANCEL"}))
        .transact()
        .await?
        .into_result()?;
    ops.push((
        "cancel_invoice".into(),
        r.total_gas_burnt.as_gas() as u128,
        r.total_gas_burnt.as_gas() as u128 * gas_price,
    ));

    // Relayed stablecoin payment: the relayer pays, the payer signs.
    create(&env, "B-RELAY", Some(env.token.id().as_str())).await?;
    let signed = sign(
        &env,
        &env.patient,
        &["pay", "--id", "B-RELAY", "--share", "0"],
    );
    let relayed = submit(&env, &signed);
    let g = tx_gas(
        &env.worker.rpc_addr(),
        relayed["tx_hash"].as_str().expect("tx hash"),
        env.relayer.id().as_str(),
    )
    .await?;
    ops.push(("relayed ft_transfer_call".into(), g, g * gas_price));

    // Relayed adjudication.
    create(&env, "B-RELAY-ADJ", None).await?;
    let signed = sign(
        &env,
        &env.insurer,
        &[
            "adjudicate",
            "--id",
            "B-RELAY-ADJ",
            "--share",
            "1",
            "--approved",
            &(3 * NEAR).to_string(),
            "--reason",
            "CO-45 fee schedule",
            "--move-to",
            "0",
        ],
    );
    let relayed = submit(&env, &signed);
    let g = tx_gas(
        &env.worker.rpc_addr(),
        relayed["tx_hash"].as_str().expect("tx hash"),
        env.relayer.id().as_str(),
    )
    .await?;
    ops.push(("relayed adjudicate_share".into(), g, g * gas_price));

    // The contract must hold nothing.
    let held = balance(&env.token, env.pay.id().as_str()).await?;
    assert_eq!(held, 0, "ClinicPay must hold no tokens");
    let held_near = env
        .worker
        .view_account(env.pay.id())
        .await?
        .balance
        .as_yoctonear();

    let scale_rows = scale(&[10, 100, 1000]).await?;
    if std::env::var("CLINICPAY_SAVE_SCAN_BASELINE").is_ok() {
        std::fs::write(
            SCAN_BASELINE,
            serde_json::to_string_pretty(&rows_to_json(&scale_rows))? + "\n",
        )?;
        println!("saved scan baseline to {SCAN_BASELINE}");
    }
    let baseline: Option<Vec<Value>> = std::fs::read_to_string(SCAN_BASELINE)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());

    let near = |t: u128| t as f64 / NEAR as f64;
    let usd = |t: u128| rate.map(|r| near(t) * r);

    let mut md = String::new();
    md.push_str("# Benchmarks\n\n");
    md.push_str(&format!(
        "Generated by `cd contract && cargo run --example bench -- {}` on {date}.\n\n",
        rate.map(|r| r.to_string())
            .unwrap_or_else(|| "<near-usd>".into())
    ));
    md.push_str("Local NEAR sandbox, one 5-unit invoice per operation. Gas is `total_gas_burnt` for the transaction plus every receipt outcome; cost is gas × the node's gas price. Mainnet's minimum gas price is 1e8 yocto/gas (protocol config), so USD figures here are a floor, not a quote.\n\n");
    md.push_str(&format!("- Gas price used: **{} yocto/gas**\n- NEAR/USD: **{}**\n- Mainnet minimum: **1e8 yocto/gas**\n\n", gas_price, rate.map(|r| r.to_string()).unwrap_or_else(|| "not supplied".into())));
    md.push_str("| Operation | Gas (Tgas) | Cost (NEAR) |");
    md.push_str(if rate.is_some() {
        " Cost (USD) |\n"
    } else {
        "\n"
    });
    md.push_str("| --- | ---: | ---: |");
    md.push_str(if rate.is_some() { " ---: |\n" } else { "\n" });
    for (name, gas, tokens) in &ops {
        md.push_str(&format!(
            "| {name} | {:.3} | {:.9} |",
            tgas(*gas),
            near(*tokens)
        ));
        if let Some(u) = usd(*tokens) {
            md.push_str(&format!(" ${u:.5} |"));
        }
        md.push('\n');
    }
    let storage_cost = bytes * YOCTO_PER_BYTE;
    md.push_str(&format!(
        "\n**Storage:** {} bytes per invoice → {:.9} NEAR at 1e19 yocto/byte{}.\n\n",
        bytes,
        near(storage_cost),
        usd(storage_cost)
            .map(|u| format!(" (${u:.5})"))
            .unwrap_or_default()
    ));
    md.push_str(&format!("**Custody:** ClinicPay's token balance after every flow: {held} tUSDC. Its NEAR balance is {:.4} NEAR, which is the account's own storage and gas float, not customer money.\n\n", near(held_near)));
    md.push_str("## Scale: `list_invoices` for one clinic\n\n");
    md.push_str("One clinic owns 2 invoices; one other clinic owns the rest. `list_invoices(clinic)` is sent as a transaction (a view call reports no gas) with the default page, so it always returns the same 2 invoices and the only thing that changes is how many invoices the contract holds. *Scan* is the original implementation (walk every invoice, filter by payee), measured before the per-clinic index was added and saved in `contract/examples/scale_scan_baseline.json`. *Index* is the current code (`by_payee`). `create_invoice` is the gas of the last invoice created at that size, by the busy clinic.\n\n");
    md.push_str("| Invoices on contract | list_invoices scan (Tgas) | list_invoices index (Tgas) | create_invoice scan (Tgas) | create_invoice index (Tgas) |\n| ---: | ---: | ---: | ---: | ---: |\n");
    let base = |i: usize, k: &str| -> Option<f64> {
        baseline
            .as_ref()?
            .get(i)?
            .get(k)?
            .as_str()?
            .parse::<u128>()
            .ok()
            .map(tgas)
    };
    let base_ok = |i: usize| -> bool {
        baseline
            .as_ref()
            .and_then(|b| b.get(i))
            .and_then(|r| r.get("list_ok"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    };
    let cell = |g: Option<f64>, ok: bool| match g {
        Some(g) if ok => format!("{g:.3}"),
        Some(g) => format!("{g:.3} (call failed)"),
        None => "n/a".to_string(),
    };
    for (i, r) in scale_rows.iter().enumerate() {
        md.push_str(&format!(
            "| {} | {} | {} | {} | {:.3} |\n",
            r.size,
            cell(base(i, "list_gas"), base_ok(i)),
            cell(Some(tgas(r.list_gas)), r.list_ok),
            cell(base(i, "create_gas"), true),
            tgas(r.create_gas)
        ));
    }
    let bytes_of = |i: usize| -> Option<f64> {
        baseline.as_ref()?.get(i)?.get("bytes_per_invoice")?.as_f64()
    };
    if let (Some(last), Some(old)) = (scale_rows.last(), bytes_of(scale_rows.len() - 1)) {
        md.push_str(&format!(
            "\n**Extra storage per invoice from the index:** {:.1} bytes (scan {:.1} → index {:.1} bytes per invoice, averaged over the last {} invoices, 13-character ids, {} yocto/byte). One `by_payee` entry per invoice: the id string plus its length prefix.\n\n",
            last.bytes_per_invoice - old,
            old,
            last.bytes_per_invoice,
            last.size - scale_rows[scale_rows.len() - 2].size,
            YOCTO_PER_BYTE
        ));
    } else {
        md.push_str("\n*No scan baseline saved, so there is no scan column or storage delta.*\n\n");
    }
    md.push_str("The index makes `list_invoices` independent of how many other invoices exist, but `by_payee` stores one `Vec` per clinic: each `list_invoices` page and each `create_invoice` by that clinic reads and rewrites that clinic's whole id list, so a single very large clinic still grows linearly in those two calls (see the create_invoice columns).\n\n");
    md.push_str("## Comparison (indicative, different units)\n\n");
    md.push_str("| Cost | Amount | Source |\n| --- | --- | --- |\n");
    md.push_str("| Card-not-present fee on a $50 co-pay | ~$1.75 (2.9% + $0.30) | Stripe list pricing, illustrative |\n");
    md.push_str(
        "| CAQH claim payment, manual | $3.48 per transaction | CAQH Index 2024, claim payment |\n",
    );
    md.push_str("| CAQH claim payment, electronic | $1.85 per transaction | CAQH Index 2024, claim payment |\n");
    md.push_str(&format!(
        "| ClinicPay stablecoin settlement | {:.9} NEAR{} | this benchmark |\n\n",
        near(ops[2].2),
        usd(ops[2].2)
            .map(|u| format!(" (~${u:.5})"))
            .unwrap_or_default()
    ));
    md.push_str("Sources: CAQH Index 2024 <https://caqh.org/hubfs/Index/CAQH_IndexReport_2024_FINAL.pdf>; Stripe pricing <https://stripe.com/pricing>; NEAR protocol config for the 1e8 yocto/gas minimum. Card and CAQH figures are industry cost benchmarks, not fees ClinicPay charges. The comparison is here to show order of magnitude, not to claim a like-for-like saving.\n\n");
    md.push_str("## Method\n\n- Each operation runs on its own invoice so state differences do not leak between rows.\n- `total_gas_burnt` includes the transaction and all receipts; relayed rows are read from `tx` for the relayer's transaction hash.\n- Storage is the contract account's `storage_usage` delta around one `create_invoice` (2 shares and 1 line included).\n- The relayer rows use `relayer/payer.mjs` and `relayer/relayer.mjs` exactly as the sandbox tests do.\n- The contract's token balance is asserted to be zero at the end.\n");
    std::fs::write("../docs/BENCHMARKS.md", md)?;

    println!(
        "gas price {} yocto/gas; storage {} bytes/invoice",
        gas_price, bytes
    );
    for (name, gas, tokens) in &ops {
        println!(
            "{name:28} {:>10.3} Tgas  {:.9} NEAR",
            tgas(*gas),
            near(*tokens)
        );
    }
    for r in &scale_rows {
        println!(
            "scale {:>5} invoices: list {:>9.3} Tgas{}  create {:>7.3} Tgas  {:.1} bytes/invoice",
            r.size,
            tgas(r.list_gas),
            if r.list_ok { "" } else { " (FAILED)" },
            tgas(r.create_gas),
            r.bytes_per_invoice
        );
    }
    println!("wrote docs/BENCHMARKS.md");
    Ok(())
}
