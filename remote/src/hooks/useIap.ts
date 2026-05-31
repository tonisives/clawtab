import { useEffect, useState, useCallback, useRef } from "react";
import { Platform } from "react-native";
import type { Purchase, PurchaseIOS } from "react-native-iap";
import * as api from "../api/client";

// Product ID must match what's configured in App Store Connect
const IAP_PRODUCT_ID = "cc.clawtab.pro.monthly";

type IapModule = typeof import("react-native-iap");

let RNIap: IapModule | null = null;
if (Platform.OS === "ios") {
  RNIap = require("react-native-iap");
}

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

  useEffect(() => {
    if (!RNIap || Platform.OS !== "ios") return;

    let mounted = true;
    let connected = false;
    const iap = RNIap;

    (async () => {
      try {
        await iap.initConnection();
        connected = true;
        const products = await iap.fetchProducts({ skus: [IAP_PRODUCT_ID], type: "subs" });
        if (!mounted) return;
        if (products && products.length > 0) {
          setAvailable(true);
          const product = products[0];
          setPrice(product.displayPrice ?? product.price ?? null);
        }
      } catch (e) {
        if (String(e).includes("E_IAP_NOT_AVAILABLE")) {
          console.log("[iap] not available (expected on dev builds)");
        } else {
          console.log("[iap] init error:", e);
        }
      }
    })();

    return () => {
      mounted = false;
      if (connected) {
        iap.endConnection();
      }
    };
  }, []);

  const purchase = useCallback(async (): Promise<boolean> => {
    if (!RNIap || !available) return false;
    const iap = RNIap;

    setPurchasing(true);
    try {
      if (purchaseListenerRef.current) {
        purchaseListenerRef.current.remove();
        purchaseListenerRef.current = null;
      }

      return await new Promise<boolean>((resolve) => {
        let resolved = false;

        const listener = iap.purchaseUpdatedListener(async (purchase) => {
          if (resolved) return;

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
    if (!RNIap) return false;
    const iap = RNIap;

    setPurchasing(true);
    try {
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
    purchase,
    restore,
  };
}
