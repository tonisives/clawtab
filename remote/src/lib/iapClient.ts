import type { Purchase } from "react-native-iap"

type Store = typeof import("react-native-iap")
export const IAP_PRODUCT_ID = "cc.clawtab.pro.monthly"
export type IapResult = { status: "purchased" | "cancelled" | "pending" | "failed" | "not-found"; message?: string }
export type IapState = {
  available: boolean; price: string | null; loading: boolean; purchasing: boolean
  error: string | null; diagnostic: string | null; activation: number
}
type Dependencies = {
  loadStore: () => Store
  verify: (signed: string, userId: string) => Promise<{ subscribed: boolean }>
  onVerified: (userId: string) => void
  isActive: () => boolean
  onActive: (callback: (active: boolean) => void) => () => void
}
let timeout = async <T,>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Store request timed out")), ms)
  })]) } finally { clearTimeout(timer) }
}
let signedValue = (value?: string | null) => value && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) ? value : null
let resultForError = (error: unknown): IapResult => {
  let code = (error as { code?: string })?.code
  if (code === "user-cancelled") return { status: "cancelled" }
  if (code === "deferred-payment") return { status: "pending", message: "Your purchase is awaiting approval from Apple." }
  return { status: "failed", message: "Could not complete the App Store request. Please try again." }
}

export let createIapClient = (dependencies: Dependencies) => {
  let state: IapState = { available: false, price: null, loading: true, purchasing: false, error: null, diagnostic: null, activation: 0 }
  let subscribers = new Set<() => void>()
  let set = (patch: Partial<IapState>) => { state = { ...state, ...patch }; subscribers.forEach((callback) => callback()) }
  let account: string | null = null
  let generation = 0
  let connection: Promise<Store> | null = null
  let installed = false
  let catalog: Promise<void> | null = null
  let recovering: Promise<void> | null = null
  let stages: string[] = []
  let trace = (stage: string) => {
    stages = [...stages, `${new Date().toISOString().slice(11, 19)} ${stage}`].slice(-12)
    set({ diagnostic: `Product: ${IAP_PRODUCT_ID}\n${stages.join("\n")}` })
  }
  type Operation = {
    userId: string; generation: number; accepted: boolean; finish: (result: IapResult) => void
    accept: () => void; result: Promise<IapResult>
  }
  let operation: Operation | null = null
  let verifying = new Map<string, Promise<IapResult>>()
  let getStore = () => {
    if (!connection) connection = (async () => {
      let store = dependencies.loadStore()
      if (!await timeout(store.initConnection(), 15_000)) throw new Error("Store unavailable")
      if (!installed) {
        store.purchaseUpdatedListener((purchase) => { void receive(purchase) }, { dedupeTransactionIOS: false })
        store.purchaseErrorListener((error) => fail(error))
        installed = true
      }
      return store
    })().catch((error) => { connection = null; throw error })
    return connection
  }
  let fail = (error: unknown, expected = operation) => {
    if (!expected || operation !== expected) return
    if (expected.accepted) { trace("error-after-purchase-ignored"); return }
    expected.finish(resultForError(error))
  }
  let begin = (action: "purchase" | "restore") => {
    if (!account || operation) return null
    let resolve: (result: IapResult) => void = () => undefined
    let result = new Promise<IapResult>((done) => { resolve = done })
    let timer: ReturnType<typeof setTimeout> | undefined
    let duration = action === "purchase" ? 120_000 : 90_000
    let unsubscribe = () => undefined as void
    let current: Operation = {
      userId: account, generation, accepted: false, result,
      finish: (value) => {
        if (operation !== current) return
        clearTimeout(timer); unsubscribe(); operation = null
        set({ purchasing: false }); trace(`${action}-${value.status}`); resolve(value)
      },
      accept: () => {
        if (current.accepted) return
        current.accepted = true; duration = 90_000; arm()
      },
    }
    let arm = () => {
      clearTimeout(timer)
      if (!dependencies.isActive()) return
      timer = setTimeout(() => current.finish({ status: "pending", message: "Apple is taking longer than expected. Use Restore Purchases to check again." }), duration)
    }
    operation = current
    unsubscribe = dependencies.onActive((active) => { if (active) arm(); else clearTimeout(timer) })
    set({ purchasing: true }); trace(`${action}-start`); arm()
    return current
  }
  let receive = async (purchase: Purchase): Promise<IapResult> => {
    let userId = account, revision = generation
    if (!userId || purchase.productId !== IAP_PRODUCT_ID || purchase.platform !== "ios") return { status: "not-found" }
    if (purchase.purchaseState !== "purchased") return { status: "pending", message: "Your purchase is awaiting confirmation from Apple." }
    let current = operation?.userId === userId && operation.generation === revision ? operation : null
    current?.accept()
    trace("purchase-received")
    let key = `${revision}:${purchase.transactionId}`
    let pending = verifying.get(key)
    if (!pending) {
      pending = (async (): Promise<IapResult> => {
        let store = await getStore()
        let verified: { subscribed: boolean }
        try {
          if (!purchase.transactionId) throw new Error("Missing transaction")
          let signed = signedValue(purchase.purchaseToken)
          if (!signed) {
            trace("signed-transaction-read")
            signed = signedValue(await timeout(store.getTransactionJwsIOS(purchase.productId), 15_000))
          }
          if (!signed) throw new Error("Missing signed transaction")
          if (account !== userId || generation !== revision) return { status: "cancelled" }
          trace("verification-start")
          verified = await timeout(dependencies.verify(signed, userId), 45_000)
          trace("verification-complete")
        } catch (error) {
          trace("verification-pending")
          return { status: "pending", message: (error as { status?: number })?.status === 409
            ? "This Apple subscription belongs to another ClawTab account. Sign in to that account to restore it."
            : "Apple accepted your purchase, but activation is pending. Use Restore Purchases to retry." }
        }
        // Verification persisted the entitlement. Finishing is cleanup and must
        // never change a verified purchase into a failed one.
        try { await timeout(store.finishTransaction({ purchase, isConsumable: false }), 5_000); trace("finish-complete") }
        catch { trace("finish-pending") }
        if (account !== userId || generation !== revision) return { status: "cancelled" }
        set({ activation: state.activation + 1 })
        if (verified.subscribed) dependencies.onVerified(userId)
        return verified.subscribed ? { status: "purchased" } : { status: "not-found", message: "No active Apple subscription was found." }
      })().catch((): IapResult => ({ status: "pending", message: "Could not verify your purchase. Use Restore Purchases to retry." }))
      verifying.set(key, pending)
    }
    let result = await pending
    verifying.delete(key)
    if (current && operation === current) current.finish(result)
    return result
  }
  let retry = () => {
    if (!catalog) {
      set({ loading: true, error: null })
      catalog = (async () => {
        try {
          let store = await getStore()
          let products = await timeout(store.fetchProducts({ skus: [IAP_PRODUCT_ID], type: "subs" }), 15_000)
          let product = products?.find((item) => item.id === IAP_PRODUCT_ID)
          set({ available: !!product, price: product?.displayPrice ?? null,
            error: product ? null : "The App Store did not return the relay subscription. Retry loading purchases." })
          trace(product ? "product-ready" : "product-not-returned")
        } catch {
          set({ available: false, error: "Could not load purchases from the App Store. Check your connection and retry." })
          trace("store-unavailable")
        } finally { set({ loading: false }); catalog = null }
      })()
    }
    return catalog
  }
  let restoreAvailable = async (explicit: boolean, current?: Operation) => {
    let userId = account, revision = generation
    if (!userId) return
    try {
      let store = await getStore()
      // Only an explicit restore may trigger another Apple authentication prompt.
      if (explicit) await store.syncIOS()
      let purchases = await timeout(store.getAvailablePurchases(), 15_000)
      if (account !== userId || generation !== revision) return
      let matching = purchases.filter((purchase) => purchase.productId === IAP_PRODUCT_ID)
        .sort((left, right) => right.transactionDate - left.transactionDate)
      if (!matching.length && !current?.accepted) current?.finish({ status: "not-found", message: "No Apple subscription was found. Check the Apple account used for your purchase." })
      for (let purchase of matching) await receive(purchase)
    } catch {
      if (current?.accepted) trace("error-after-purchase-ignored")
      else current?.finish({ status: "failed", message: "Could not restore purchases. Please try again." })
      trace("restore-unavailable")
    }
  }
  let recover = () => {
    if (!recovering) recovering = restoreAvailable(false).finally(() => { recovering = null })
    return recovering
  }
  dependencies.onActive((active) => {
    if (!active) return
    if (!state.available) void retry()
    if (account && !operation) void recover()
  })
  return {
    getState: () => state,
    subscribe: (callback: () => void) => { subscribers.add(callback); return () => { subscribers.delete(callback) } },
    setAccount: (userId: string | null) => {
      if (account === userId) return
      operation?.finish({ status: "cancelled" }); account = userId; generation++
      // A previous account's lookup must not suppress recovery for this account.
      recovering = null
      if (userId) void recover()
    },
    retry,
    purchase: async (): Promise<IapResult> => {
      if (!state.available) return { status: "failed", message: "Purchases are not ready. Retry loading purchases." }
      let current = begin("purchase")
      if (!current) return { status: "failed", message: "Sign in before purchasing, and wait for any purchase in progress." }
      void getStore().then((store) => {
        if (operation !== current) return
        trace("purchase-request")
        return store.requestPurchase({ request: { apple: { sku: IAP_PRODUCT_ID, appAccountToken: current.userId } }, type: "subs" }).then((value) => {
          let purchases = Array.isArray(value) ? value : value ? [value] : []
          for (let purchase of purchases) void receive(purchase)
        })
      }).catch((error) => fail(error, current))
      return current.result
    },
    restore: async (): Promise<IapResult> => {
      let current = begin("restore")
      if (!current) return { status: "failed", message: "Sign in before restoring, and wait for any purchase in progress." }
      void restoreAvailable(true, current)
      return current.result
    },
  }
}
