import { useEffect, useState, useCallback, useRef } from "react";
import { AppState, Platform } from "react-native";
import type { Purchase, PurchaseIOS } from "react-native-iap";
import * as api from "../api/client";

// Product ID must match what's configured in App Store Connect
const IAP_PRODUCT_ID = "cc.clawtab.pro.monthly";

type IapModule = typeof import("react-native-iap");

let storeConnection: Promise<IapModule> | null = null;
let getStore = () => {
  if (!storeConnection) {
    storeConnection = (async () => {
      let iap: IapModule = require("react-native-iap");
      if (!await iap.initConnection()) throw new Error("App Store connection was not established");
      return iap;
    })().catch((error) => { storeConnection = null; throw error; });
  }
  return storeConnection;
};
let withStoreTimeout = async <T,>(operation: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("App Store request timed out")), 15000);
    })]);
  } finally { clearTimeout(timer!); }
};

function getIosReceiptFields(purchase: Purchase): {
  originalTransactionId: string;
  expiresDateMs?: number;
} {
  if (purchase.platform !== "ios") {
    return { originalTransactionId: purchase.transactionId ?? "" };
  }

  const iosPurchase = purchase as PurchaseIOS;
  return {
    originalTransactionId: iosPurchase.originalTransactionIdentifierIOS ?? iosPurchase.transactionId,
    expiresDateMs: iosPurchase.expirationDateIOS ?? undefined,
  };
}

export function useIap() {
  const [available, setAvailable] = useState(false);
  const [price, setPrice] = useState<string | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  const purchaseListenerRef = useRef<{ remove: () => void } | null>(null);

  let [loading, setLoading] = useState(Platform.OS === "ios");
  let [error, setError] = useState<string | null>(null);
  let [diagnostic, setDiagnostic] = useState<string | null>(null);
  let iapRef = useRef<IapModule | null>(null);
  let mounted = useRef(false);
  let loadingRef = useRef(false);
  let availableRef = useRef(false);
  let retry = useCallback(async () => {
    if (Platform.OS !== "ios" || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    setDiagnostic(null);
    try {
      let iap = await withStoreTimeout(getStore());
      iapRef.current = iap;
      let products = await withStoreTimeout(iap.fetchProducts({ skus: [IAP_PRODUCT_ID], type: "subs" }));
      if (!mounted.current) return;
      let product = products?.find((item) => item.id === IAP_PRODUCT_ID);
      if (!product) {
        setAvailable(false);
        availableRef.current = false;
        setError("The App Store did not return the relay subscription. Retry loading purchases.");
        setDiagnostic(`Product: ${IAP_PRODUCT_ID} · No matching product returned`);
        return;
      }
      setAvailable(true);
      availableRef.current = true;
      setPrice(product.displayPrice ?? String(product.price ?? ""));
    } catch (error) {
      storeConnection = null;
      if (!mounted.current) return;
      setAvailable(false);
      availableRef.current = false;
      setError("Could not load purchases from the App Store. Check your connection and retry.");
      let code = (error as { code?: unknown })?.code;
      setDiagnostic(`Product: ${IAP_PRODUCT_ID} · ${typeof code === "string" ? code : error instanceof Error ? error.message : "Store connection failed"}`);
    } finally {
      loadingRef.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void retry();
    let listener = AppState.addEventListener("change", (state) => {
      if (state === "active" && !availableRef.current) void retry();
    });
    return () => {
      mounted.current = false;
      listener.remove();
      purchaseListenerRef.current?.remove();
      purchaseListenerRef.current = null;
    };
  }, [retry]);

  const purchase = useCallback(async (): Promise<boolean> => {
    if (!iapRef.current || !available) return false;
    const iap = iapRef.current;

    setPurchasing(true);
    try {
      if (purchaseListenerRef.current) {
        purchaseListenerRef.current.remove();
        purchaseListenerRef.current = null;
      }

      return await new Promise<boolean>((resolve) => {
        let resolved = false;

        const listener = iap.purchaseUpdatedListener(async (purchase) => {
          if (resolved || purchase.productId !== IAP_PRODUCT_ID) return;

          if (!purchase.transactionId) {
            resolved = true;
            resolve(false);
            return;
          }

          try {
            const receiptFields = getIosReceiptFields(purchase);
            await api.verifyIapReceipt({
              original_transaction_id: receiptFields.originalTransactionId,
              product_id: purchase.productId,
              expires_date_ms: receiptFields.expiresDateMs,
            });

            await iap.finishTransaction({ purchase, isConsumable: false });

            resolved = true;
            resolve(true);
          } catch (e) {
            console.log("[iap] verify error:", e);
            resolved = true;
            resolve(false);
          }
        });

        purchaseListenerRef.current = listener;

        const errorListener = iap.purchaseErrorListener((error) => {
          if (resolved) return;
          console.log("[iap] purchase error:", error.code, error.message);
          resolved = true;
          resolve(false);
        });

        const originalRemove = listener.remove;
        listener.remove = () => {
          originalRemove();
          errorListener.remove();
        };

        iap.requestPurchase({ request: { apple: { sku: IAP_PRODUCT_ID } }, type: "subs" }).catch((e) => {
          if (resolved) return;
          console.log("[iap] request error:", e);
          resolved = true;
          resolve(false);
        });
      });
    } finally {
      setPurchasing(false);
      if (purchaseListenerRef.current) {
        purchaseListenerRef.current.remove();
        purchaseListenerRef.current = null;
      }
    }
  }, [available]);

  const restore = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== "ios") return false;
    setPurchasing(true);
    try {
      let iap = await withStoreTimeout(getStore());
      const purchases = await iap.getAvailablePurchases();
      const sub = purchases.find((p) => p.productId === IAP_PRODUCT_ID);
      if (!sub) return false;

      const receiptFields = getIosReceiptFields(sub);
      await api.verifyIapReceipt({
        original_transaction_id: receiptFields.originalTransactionId,
        product_id: sub.productId,
        expires_date_ms: receiptFields.expiresDateMs,
      });

      return true;
    } catch (e) {
      console.log("[iap] restore error:", e);
      return false;
    } finally {
      setPurchasing(false);
    }
  }, []);

  return {
    available: Platform.OS === "ios" && available,
    price,
    purchasing,
    loading,
    error,
    diagnostic,
    retry,
    purchase,
    restore,
  };
}
