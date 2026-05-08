import { isVideoAssetKind } from "@marketing/shared-types";

export type AssetMediaInput = {
  kind?: string | null;
  mimeType?: string | null;
};

export function isVideoAsset(asset: AssetMediaInput): boolean {
  if (asset.mimeType && asset.mimeType.startsWith("video/")) return true;
  if (asset.kind && isVideoAssetKind(asset.kind)) return true;
  return false;
}
