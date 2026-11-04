// Host-only privileged handlers. This module runs on the project owner's
// machine (never in the client bundle, never imported by action code):
// it holds the ONLY code path that touches the HamsterNFT v2 server
// signer key. The key lives in the owner's local deployer wallet file
// (~/workspace/hamster-contracts/deployer-wallet.json, the deployment
// wallet that is also the contract's serverSigner / feeRecipient); it is
// read here at signing time, used to sign one mint authorisation, and
// never returned, logged, or sent anywhere else.

import { readFile } from "node:fs/promises";
import { definePrivilegedContracts, definePrivilegedHandlers, z } from "@hatch/space-sdk";
import { bytesToHex, hexToBytes, keccak256, recoverDigestSign, signDigest } from "./evm";

const DEPLOYER_WALLET_PATH = "/home/hatch/workspace/hamster-contracts/deployer-wallet.json";

export const PrivilegedContracts = definePrivilegedContracts({
  signMintAuthorization: {
    request: z.object({
      player: z.string(),
      species: z.number(),
      deadline: z.number(),
      nonce: z.number(),
    }),
    response: z.object({
      signature: z.string(),
      signer: z.string(),
    }),
    capabilities: ["filesystem:read:hamster-contracts/deployer-wallet.json"],
  },
  submitChampionProof: {
    request: z.object({
      dayId: z.number(),
      player: z.string(),
      score: z.number(),
      distance: z.number(),
      species: z.number(),
      squeekBlock: z.number(),
      payloadHash: z.string(),
    }),
    response: z.object({
      txHash: z.string(),
      signer: z.string(),
    }),
    capabilities: ["filesystem:read:hamster-contracts/deployer-wallet.json"],
  },
});

const SCORE_LEDGER = "0xFB650C5503A2A05f01D4DF91e5a522EbD1Eba552";
const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const SEPOLIA_CHAIN_ID = 11155111;

/* ------------------------- raw tx plumbing (RLP) ------------------------ */

function selectorHex(signature: string): string {
  const hash = keccak256(new TextEncoder().encode(signature));
  return bytesToHex(hash.slice(0, 4));
}

function uintWord(v: number | bigint): Uint8Array {
  const hex = v.toString(16).padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bigintBytes(v: bigint): Uint8Array {
  if (v === 0n) return new Uint8Array(0);
  let hex = v.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return hexToBytes("0x" + hex);
}

function rlpBytes(b: Uint8Array): Uint8Array {
  if (b.length === 1 && b[0]! < 0x80) return b;
  if (b.length <= 55) return new Uint8Array([0x80 + b.length, ...b]);
  const len = bigintBytes(BigInt(b.length));
  return new Uint8Array([0xb7 + len.length, ...len, ...b]);
}

function rlpList(items: Uint8Array[]): Uint8Array {
  const parts = items.map(rlpBytes);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const payload = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    payload.set(p, off);
    off += p.length;
  }
  if (total <= 55) return new Uint8Array([0xc0 + total, ...payload]);
  const len = bigintBytes(BigInt(total));
  return new Uint8Array([0xf7 + len.length, ...len, ...payload]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rpc(method: string, params: unknown[]): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(SEPOLIA_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    if (json?.error) throw new Error(`RPC ${method}: ${json.error.message ?? "error"}`);
    return json?.result;
  } finally {
    clearTimeout(timer);
  }
}

function encAddressWord(address: string): Uint8Array {
  const clean = address.toLowerCase().replace("0x", "").padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function encUintWord(v: number): Uint8Array {
  const hex = v.toString(16).padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const privilegedHandlers = definePrivilegedHandlers(PrivilegedContracts, {
  async signMintAuthorization(args) {
    const raw = await readFile(DEPLOYER_WALLET_PATH, "utf8");
    const wallet = JSON.parse(raw) as { address?: string; privateKey?: string };
    if (!wallet.privateKey || !wallet.address) {
      throw new Error("signer wallet file is incomplete");
    }
    // HamsterNFT v2 mint() verifies:
    //   ECDSA.recover(toEthSignedMessageHash(keccak256(abi.encode(
    //     msg.sender, species, deadline, mintNonce[msg.sender]))), sig)
    //   == serverSigner
    const encoded = new Uint8Array(128);
    encoded.set(encAddressWord(args.player), 0);
    encoded.set(encUintWord(args.species), 32);
    encoded.set(encUintWord(args.deadline), 64);
    encoded.set(encUintWord(args.nonce), 96);
    const inner = keccak256(encoded);
    const prefix = new TextEncoder().encode("\x19Ethereum Signed Message:\n32");
    const digest = keccak256(new Uint8Array([...prefix, ...inner]));
    const signature = signDigest(digest, wallet.privateKey);
    if (!signature) throw new Error("signing failed");
    // Self-check before the signature leaves the host: it must recover
    // to the signer address, exactly as the contract will verify it.
    const recovered = recoverDigestSign(digest, signature);
    if (!recovered || recovered.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error("signature self-check failed");
    }
    return { signature, signer: wallet.address.toLowerCase() };
  },

  async submitChampionProof(args) {
    const raw = await readFile(DEPLOYER_WALLET_PATH, "utf8");
    const wallet = JSON.parse(raw) as { address?: string; privateKey?: string };
    if (!wallet.privateKey || !wallet.address) {
      throw new Error("signer wallet file is incomplete");
    }
    const from = wallet.address.toLowerCase();

    // ScoreLedger.submitChampion(uint32, Champion, bytes): the deployer
    // wallet is BOTH the contract owner and its reporter, and the
    // contract lets the owner write directly with an empty signature.
    const payloadHashBytes = hexToBytes(args.payloadHash);
    if (payloadHashBytes.length !== 32) throw new Error("bad payload hash");
    // Champion is a STATIC tuple (every field is a value type), so the
    // ABI encodes it inline right after dayId — no offset pointer. The
    // head is dayId + 6 tuple words + the offset word itself = 8 words,
    // so the dynamic bytes argument starts at offset 0x100.
    // (Byte-compared against viem's encodeFunctionData + a live eth_call.)
    const words: Uint8Array[] = [
      uintWord(args.dayId),
      encAddressWord(args.player),
      uintWord(args.score),
      uintWord(args.distance),
      uintWord(args.species),
      uintWord(args.squeekBlock),
      payloadHashBytes,
      uintWord(0x100), // bytes offset
      uintWord(0), // empty signature
    ];
    const dataLen = words.reduce((n, w) => n + w.length, 0);
    const data = new Uint8Array(4 + dataLen);
    data.set(hexToBytes("0x" + selectorHex("submitChampion(uint32,(address,uint64,uint32,uint16,uint64,bytes32),bytes)")), 0);
    let off = 4;
    for (const w of words) {
      data.set(w, off);
      off += w.length;
    }
    const dataHex = "0x" + bytesToHex(data);

    const nonce = BigInt(await rpc("eth_getTransactionCount", [from, "pending"]));
    const gasPriceRaw = BigInt(await rpc("eth_gasPrice", []));
    const gasPrice = (gasPriceRaw * 13n) / 10n + 1n;
    let gasLimit = 250000n;
    try {
      const est = BigInt(await rpc("eth_estimateGas", [{ from, to: SCORE_LEDGER, data: dataHex }]));
      gasLimit = (est * 13n) / 10n + 5000n;
    } catch {
      /* keep the fallback limit */
    }

    const unsigned = rlpList([
      bigintBytes(nonce),
      bigintBytes(gasPrice),
      bigintBytes(gasLimit),
      hexToBytes(SCORE_LEDGER),
      new Uint8Array(0),
      data,
      bigintBytes(BigInt(SEPOLIA_CHAIN_ID)),
      new Uint8Array(0),
      new Uint8Array(0),
    ]);
    const digest = keccak256(unsigned);
    const signature = signDigest(digest, wallet.privateKey);
    if (!signature) throw new Error("signing failed");
    const sigBytes = hexToBytes(signature);
    const recId = BigInt(sigBytes[64]! - 27);
    const v = BigInt(SEPOLIA_CHAIN_ID) * 2n + 35n + recId;
    const signedTx = rlpList([
      bigintBytes(nonce),
      bigintBytes(gasPrice),
      bigintBytes(gasLimit),
      hexToBytes(SCORE_LEDGER),
      new Uint8Array(0),
      data,
      bigintBytes(v),
      sigBytes.slice(0, 32),
      sigBytes.slice(32, 64),
    ]);
    const txHash: string = await rpc("eth_sendRawTransaction", ["0x" + bytesToHex(signedTx)]);
    // Wait for the receipt so a revert is reported as a failure, never
    // as a stored proof.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const receipt: any = await rpc("eth_getTransactionReceipt", [txHash]).catch(() => null);
      if (receipt) {
        if (receipt.status === "0x1") return { txHash, signer: from };
        throw new Error("champion transaction reverted on chain");
      }
    }
    throw new Error("champion transaction not confirmed in time");
  },
});
