// wallet.js
// Uses global onlypawsClient

async function loadWalletStatus() {
  const { data, error } = await onlypawsClient
    .from("v_wallet_status")
    .select(`
      wallet_id,
      currency,
      available_cents,
      pending_cents,
      meets_minimum_withdraw,
      has_open_withdrawal
    `)
    .single();

  if (error) throw error;
  return data;
}

async function requestWithdrawal(amountEuro) {
  const amount_cents = Math.round(amountEuro * 100);

  const { data, error } = await onlypawsClient.rpc(
    "request_withdrawal",
    { amount_cents }
  );

  if (error) throw error;
  return data;
}

// expose
window.OPWallet = {
  loadWalletStatus,
  requestWithdrawal,
};
