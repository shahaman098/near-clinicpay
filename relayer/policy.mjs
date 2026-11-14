// What the ClinicPay relayer agrees to pay gas for. Everything else is refused
// before a transaction is built, so the relayer's NEAR only ever buys ClinicPay calls.
//
// Under NEP-366 the relayer funds every deposit attached inside a delegate action, not
// just the gas. So the relayer never relays a call with a real deposit: NEAR-priced
// shares (pay_share carries the payment as its deposit) are paid directly by the payer.
//
// Allowed (exactly one function-call action per delegate):
//   * ClinicPay.adjudicate_share     (insurers record a claim decision; no deposit)
//   * <listed token>.ft_transfer_call with receiver_id = ClinicPay and 1 yoctoNEAR
//     (stablecoin invoices)
// and, before spending gas, the target share must be open, payable by this sender,
// and the amount must match it exactly; adjudications must pass the contract's own
// rules; token payments need the sender's balance and both registrations on the token.

export const MAX_GAS = 150n * 10n ** 12n; // 150 Tgas
export const MAX_BLOCKS_AHEAD = 1000n; // a delegate may be valid for at most ~15 minutes

export class Refused extends Error {}
const refuse = (msg) => { throw new Refused(msg); };

/** Static checks: shape, receiver, method, deposit, gas. Returns {kind, invoice_id, share_index, amount}. */
export function checkShape(d, { contract, tokens, height }) {
  if (!d.valid) refuse("bad signature on the delegate action");
  if (d.actions.length !== 1) refuse("exactly one action per delegate");
  const a = d.actions[0];
  if (a.type !== "FunctionCall") refuse(`only function calls are relayed (got ${a.type})`);
  if (a.gas > MAX_GAS) refuse("gas above 150 Tgas");
  if (!a.args || typeof a.args !== "object") refuse("arguments must be JSON");
  if (height !== undefined) {
    if (d.max_block_height <= height) refuse("delegate action has expired");
    if (d.max_block_height > height + MAX_BLOCKS_AHEAD) refuse("delegate action is valid for too long");
  }

  if (d.receiver_id === contract) {
    if (a.method_name === "pay_share") {
      refuse("NEAR-priced shares are paid directly: a relayed pay_share would spend the relayer's NEAR, not the payer's");
    }
    if (a.method_name === "adjudicate_share") {
      if (a.deposit !== 0n) refuse("adjudicate_share takes no deposit");
      let approved;
      try { approved = BigInt(a.args.approved); } catch { refuse("bad approved amount"); }
      const reason = a.args.reason;
      if (typeof reason !== "string" || !reason.trim() || Buffer.byteLength(reason) > 200) refuse("reason must be 1-200 characters");
      const move_to = a.args.move_to ?? null;
      return { kind: "adjudicate", invoice_id: a.args.invoice_id, share_index: a.args.share_index, approved, move_to };
    }
    refuse(`method ${a.method_name} is not relayed`);
  }
  if (tokens.includes(d.receiver_id)) {
    if (a.method_name !== "ft_transfer_call") refuse(`token method ${a.method_name} is not relayed`);
    if (a.deposit !== 1n) refuse("ft_transfer_call must attach exactly 1 yoctoNEAR");
    if (a.args.receiver_id !== contract) refuse("tokens may only be sent to ClinicPay");
    let msg;
    try { msg = JSON.parse(a.args.msg); } catch { refuse("ft_transfer_call msg must be ClinicPay JSON"); }
    if (msg.action && msg.action !== "pay") refuse("only payments are relayed");
    let amount;
    try { amount = BigInt(a.args.amount); } catch { refuse("bad amount"); }
    return { kind: "pay_token", token: d.receiver_id, invoice_id: msg.invoice_id, share_index: msg.share_index, amount };
  }
  refuse(`receiver ${d.receiver_id} is not ClinicPay or a listed token`);
}

/** Live checks against the invoice, so the relayer never pays for a call that must fail. */
export function checkInvoice(intent, sender, invoice) {
  if (!invoice) refuse(`no invoice ${intent.invoice_id}`);
  if (invoice.cancelled) refuse("invoice is cancelled");
  const share = invoice.shares[intent.share_index];
  if (!Number.isInteger(intent.share_index) || !share) refuse("no such share");
  if (share.state !== "Open") refuse(`share is ${share.state}`);
  if (share.payer && share.payer !== sender) refuse("sender is not this share's named payer");
  if (intent.kind === "adjudicate") {
    // Mirror the contract's rules so the relayer never pays for a rejected decision.
    if (!share.payer) refuse("only a named payer can adjudicate");
    if (share.adjudication) refuse("share already adjudicated");
    if (intent.approved < 0n || intent.approved > BigInt(share.amount)) refuse("approved amount cannot exceed the share");
    if (intent.approved < BigInt(share.amount)) {
      const t = intent.move_to;
      if (t === null) refuse("move_to is required when approving less than the share");
      if (t === intent.share_index) refuse("move_to must be another share");
      const target = Number.isInteger(t) ? invoice.shares[t] : undefined;
      if (!target) refuse("no such move_to share");
      if (target.state !== "Open" || target.adjudication) refuse("move_to share must be open and not adjudicated");
    }
    return;
  }
  if (intent.kind === "pay_token" && invoice.token !== intent.token) refuse("invoice is not priced in this token");
  if (BigInt(share.amount) !== intent.amount) refuse("amount does not match the share");
}

/** Token payments: the sender must hold the amount, and ClinicPay and the clinic must
 *  both be registered on the token, or the transfer or the forward would fail after
 *  the relayer had already paid the gas. */
export function checkToken(intent, { senderBalance, contractRegistered, clinicRegistered }) {
  if (intent.kind !== "pay_token") return;
  if (BigInt(senderBalance ?? "0") < intent.amount) refuse("sender does not hold enough of the token");
  if (!contractRegistered) refuse("ClinicPay is not registered on the token (storage_deposit)");
  if (!clinicRegistered) refuse("the clinic is not registered on the token (storage_deposit)");
}
