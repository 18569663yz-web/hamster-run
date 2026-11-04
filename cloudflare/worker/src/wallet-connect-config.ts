/**
 * WalletConnect configuration for the QR sign-in fallback.
 *
 * Set WALLET_CONNECT_PROJECT_ID to the project owner's own Reown
 * (formerly WalletConnect Cloud) Project ID before enabling QR sign-in.
 * The ID is a public client identifier, but it must belong to this
 * project — never borrow another app's ID. Empty means "not configured":
 * the client then shows an honest pending-configuration state and does
 * not render a connection QR code.
 */
export const WALLET_CONNECT_PROJECT_ID = "0e3718824dfdf9299060e088f0ad5e13";
export const WALLET_CONNECT_CHAIN_ID = 11155111; // Sepolia
