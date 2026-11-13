# ClinicPay

**Split-payer invoices for clinics, settled on NEAR with an on-chain receipt for every payment.**
Track: Real-World Money (`realworld`). Built at NEAR HACKATHON, 2026-11-13 to 2026-11-14.

## The problem

A private clinic bill is rarely paid by one person. The insurer owes one slice, the
patient owes the co-pay, sometimes an employer scheme owes a third. Today the clinic
chases each party by email, reconciles bank lines by hand, and cannot easily prove
who paid what and when. Refunds are another manual round trip.

## What ClinicPay does

- A clinic creates **one invoice** made of line items and **several shares**, each
  share naming who owes it (or "anyone").
- **Each share is paid separately**, from the payer's own NEAR account. The contract
  forwards the money to the clinic **in the same transaction**. It never holds funds.
- Every payment writes a **NEP-297 event** (`share_paid`), so the receipt is on-chain
  and indexable. The invoice flips to `Paid` once every share is paid.
- The clinic can **refund** a paid share. The money goes back to whoever paid it.
- If forwarding to the clinic fails, the payment is **rolled back and the payer is
  refunded** automatically (tested).
- A zero-dependency **CLI** reads invoices straight from chain and exports an
  **accountant-ready CSV** (one row per share).

## How NEAR is used

| Piece | NEAR feature |
| --- | --- |
| `contract/src/lib.rs` | Rust contract on `near-sdk` 5: payable calls, `Promise` transfers, cross-contract-style callbacks (`on_payout`, `on_refund`) for atomic rollback, NEP-297 event logs |
| `cli/` | NEAR JSON-RPC `query` / `call_function` views (no SDK needed) |
| tests | `near-workspaces` sandbox: the real wasm runs on a real local NEAR node |

Amounts are native NEAR (yoctoNEAR on chain). Stablecoin (NEP-141) settlement is not
implemented; see Limitations.

## Try it: do X, see Y

Requirements: Rust (stable, 1.95+ because of `near-sdk` 5.30) with the
`wasm32-unknown-unknown` target, Node 18+. No NEAR account, no keys, no network
funds needed: everything below runs on a local sandbox node.

1. **Run all tests.**
   ```sh
   npm test                      # 5 CLI tests (mock RPC node)
   cd contract && cargo test     # 13 unit tests + 4 sandbox end-to-end tests
   ```
   You should see `test result: ok. 13 passed` and `ok. 4 passed`. The sandbox tests
   deploy the wasm, create an invoice, pay it from two accounts, assert the clinic's
   balance rose by exactly 5 NEAR and that the contract kept nothing, refund a share,
   and kill the clinic account to prove a failed payout is reverted and refunded.

2. **Run the live demo** (starts a local node and leaves it running):
   ```sh
   cd contract && cargo run --example demo
   ```
   It prints a contract id, accounts, an RPC URL, and the on-chain `share_paid`
   receipt for the patient's co-pay.

3. **Read it back** with the commands the demo prints, from the repo root:
   ```sh
   node cli/clinicpay.mjs status --contract <contract> --id INV-2026-0042 --rpc <rpc-url>
   node cli/clinicpay.mjs export --contract <contract> --clinic <clinic> --rpc <rpc-url>
   ```
   `status` shows `PartiallyPaid`, the paid co-pay with payer and timestamp, the open
   insurer share, and the exact `near` CLI command that pays it. `export` prints the CSV.

4. **Build the wasm** for deployment: `npm run build:wasm`
   (`contract/target/wasm32-unknown-unknown/release/clinicpay.wasm`).

### Contract API

| Call | Who | Notes |
| --- | --- | --- |
| `create_invoice(id, memo, lines, shares, due_ms)` | clinic (becomes payee) | shares must sum to lines |
| `pay_share(invoice_id, share_index)` | payer, `#[payable]` | attach exactly the share amount; forwarded to clinic |
| `refund_share(invoice_id, share_index)` | clinic, `#[payable]` | attach the share amount; goes to the original payer |
| `cancel_invoice(invoice_id)` | clinic | only while nothing is paid |
| `get_invoice`, `get_status`, `list_invoices` | view | status: Open, PartiallyPaid, Paid, Refunded, Overdue, Cancelled |

Build arguments for `create_invoice` without hand-writing yocto amounts:

```sh
node cli/clinicpay.mjs args --id INV-7 --memo "GP visit" \
  --line "Consultation=2" --line "Blood panel=3" \
  --share "Patient co-pay:patient.testnet=1" --share "Insurer:insurer.testnet=4"
```

## Security notes

- The contract never custodies funds: payment is forwarded in the same call, and a
  failed forward reverts state and refunds the payer.
- Exact-amount deposits only; a named share can only be paid by its named account.
- Only the clinic that created an invoice can refund or cancel it.
- No keys in this repo. The CLI is read-only.

## Limitations (honest)

- Native NEAR only. Real clinics want stablecoins; the next step is NEP-141 (USDC)
  settlement via `ft_transfer_call`, and a meta-transaction relayer so patients need
  no gas.
- `list_invoices` scans all invoices (fine at demo scale; needs an index at volume).
- `web/invoice.html` is a read-only convenience viewer that uses the same RPC calls
  as the CLI. It is **not** browser-tested; the tested interfaces are the contract and CLI.
- Not deployed to testnet or mainnet from this repo: deploying needs the team's own
  NEAR account. All demonstrated flows run on the local sandbox.
- Not audited. Do not use with real patient data.

## Libraries and baseline disclosure

- `near-sdk` 5.30, `near-workspaces` 0.24 (dev only), `tokio`, `serde_json`, `anyhow`.
- CLI and page: Node standard library and browser APIs only.
- Everything in this repository was written during the hackathon window for this
  entry. It is inspired by the owner's product Boto (boto.clinic, a clinic OS), but
  no Boto code is included. Written with AI assistance (Claude Code).

## Layout

```
contract/src/lib.rs        the NEAR contract + unit tests
contract/tests/sandbox.rs  end-to-end tests on a local NEAR node
contract/examples/demo.rs  live local demo
cli/                       read-only CLI + tests
web/invoice.html           read-only invoice viewer
```

License: MIT.
