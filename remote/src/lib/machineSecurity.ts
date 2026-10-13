import nacl from "tweetnacl"
import * as Crypto from "expo-crypto"
import { Platform } from "react-native"
import { configureMachineSecurity, configureMoveNavigation, resourceKey, type ClientIdentity, type MachineIdentity } from "@clawtab/shared"
import { router } from "expo-router"
import * as SecureStore from "expo-secure-store"

let storageOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
let getItem = (key: string) => SecureStore.getItemAsync(key, storageOptions)
let setItem = (key: string, value: string) => SecureStore.setItemAsync(key, value, storageOptions)

let encode = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
let decode = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
let utf8 = (text: string) => new TextEncoder().encode(text)
let decoder = new TextDecoder()
configureMoveNavigation(({ machine, pane }) => router.push({ pathname: "/process/[pane_id]", params: { pane_id: resourceKey(machine, pane).replace(/%/g, "_pct_") } }))
let creation: Promise<{ signing: Uint8Array; box: Uint8Array }> | null = null
let loadKeys = () => creation ??= (async () => {
  if (Platform.OS === "web") throw new Error("Secure Move requires the desktop or native mobile app's credential storage")
  let saved = await getItem("clawtab_secure_client_v1")
  if (saved) {
    let value = JSON.parse(saved)
    let signing = decode(value.signing)
    let box = decode(value.box)
    if (signing.length !== 32 || box.length !== 32) throw new Error("Secure client identity is invalid")
    return { signing, box }
  }
  let signing = Crypto.getRandomBytes(32)
  let box = Crypto.getRandomBytes(32)
  await setItem("clawtab_secure_client_v1", JSON.stringify({ signing: encode(signing), box: encode(box) }))
  return { signing, box }
})().catch((error) => { creation = null; throw error })
let publicKeys = async (): Promise<ClientIdentity> => {
  let keys = await loadKeys()
  return { signing_key: encode(nacl.sign.keyPair.fromSeed(keys.signing).publicKey), box_key: encode(nacl.box.keyPair.fromSecretKey(keys.box).publicKey) }
}
let fingerprint = (identity: ClientIdentity) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(identity))
let machines = async (): Promise<Record<string, MachineIdentity>> => {
  if (Platform.OS === "web") return {}
  return JSON.parse(await getItem("clawtab_secure_machines_v1") ?? "{}")
}
let keyFor = async (machine: string) => {
  let key = (await machines())[machine]
  if (!key) throw new Error("Paste this machine's verified identity from its local console first")
  let bytes = decode(key.box_key)
  if (bytes.length !== 32) throw new Error("Invalid pinned machine key")
  return bytes
}
configureMachineSecurity({
  randomId: () => Crypto.randomUUID(),
  publicIdentity: async () => {
    let identity = await publicKeys()
    return { identity, fingerprint: await fingerprint(identity) }
  },
  machines,
  pin: async (identity) => {
    if (Platform.OS === "web") throw new Error("Use the native mobile or desktop app for secure credential storage")
    if (!/^[0-9a-f-]{36}$/i.test(identity.machine_id) || decode(identity.noise_key).length !== 32 || decode(identity.box_key).length !== 32) throw new Error("Invalid machine identity")
    let known = await machines()
    let old = known[identity.machine_id]
    if (old && JSON.stringify(old) !== JSON.stringify(identity)) throw new Error("Pinned machine key changed; verify the replacement through its local console")
    known[identity.machine_id] = identity
    await setItem("clawtab_secure_machines_v1", JSON.stringify(known))
  },
  sign: async (machine, payload) => {
    let identity = await publicKeys()
    let client = await fingerprint(identity)
    let expires = Date.now() + 60_000
    let message = JSON.stringify(payload)
    let bytes = utf8(`clawtab-command-v1\n${client}\n${machine}\n${expires}\n${message}`)
    let keys = await loadKeys()
    let signature = encode(nacl.sign.detached(bytes, nacl.sign.keyPair.fromSeed(keys.signing).secretKey))
    return { client, machine, expires, message, signature }
  },
  seal: async (machine, value) => {
    let keys = await loadKeys()
    let nonce = Crypto.getRandomBytes(nacl.box.nonceLength)
    let ciphertext = nacl.box(utf8(JSON.stringify(value)), nonce, await keyFor(machine), keys.box)
    return { nonce: encode(nonce), ciphertext: encode(ciphertext) }
  },
  open: async (machine, value) => {
    let keys = await loadKeys()
    let plaintext = nacl.box.open(decode(value.ciphertext), decode(value.nonce), await keyFor(machine), keys.box)
    if (!plaintext) throw new Error("Encrypted response authentication failed")
    return JSON.parse(decoder.decode(plaintext))
  },
})
