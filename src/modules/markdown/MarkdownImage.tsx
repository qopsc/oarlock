import { useWorkspaceAssetUrl } from "@/modules/workspace";
import {
  type ComponentProps,
  type CSSProperties,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { LOCAL_IMAGE_PATH } from "./localImages";
import { remoteImages } from "./remoteImages";

type Props = ComponentProps<"img"> & {
  node?: unknown;
  [LOCAL_IMAGE_PATH]?: string;
};

type Remote =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "failed" };

export const PreviewImagesVisible = createContext(true);

function useRemoteImage(url: string | null): Remote {
  const visible = useContext(PreviewImagesVisible);
  // Returning to a URL must not display a revoked object URL from an older lease.
  const owner = useMemo(() => ({ url, visible }), [url, visible]);
  const [loaded, setLoaded] = useState<{
    owner: typeof owner;
    url: string | null;
  } | null>(null);
  useEffect(() => {
    if (owner.url === null || !owner.visible) return;
    let alive = true;
    const lease = remoteImages.acquire(owner.url);
    lease.url.then(
      (objectUrl) => {
        if (alive) setLoaded({ owner, url: objectUrl });
      },
      (e) => {
        if (!alive) return;
        console.warn("[markdown] image not loaded", owner.url, e);
        setLoaded({ owner, url: null });
      },
    );
    return () => {
      alive = false;
      lease.release();
    };
  }, [owner]);
  if (!visible || loaded?.owner !== owner) return { status: "loading" };
  return loaded.url === null
    ? { status: "failed" }
    : { status: "ready", url: loaded.url };
}

/**
 * An HTML `height` attribute in pixels as a style: Tailwind's preflight gives
 * every image `height: auto`, which beats the attribute that READMEs size
 * their logos with.
 */
export function imageHeightStyle(height: unknown): CSSProperties | undefined {
  const text = typeof height === "number" ? String(height) : height;
  if (typeof text !== "string" || !/^\d+(?:\.\d+)?$/.test(text.trim())) {
    return undefined;
  }
  return { height: `${Number(text)}px` };
}

/**
 * Images of the rendered Markdown preview. Files next to the document load
 * through the asset protocol (mapped for WSL); https images are fetched by
 * the backend, since the webview's CSP loads no remote images.
 */
export function MarkdownImage({ node: _node, src, alt, ...props }: Props) {
  const localPath = props[LOCAL_IMAGE_PATH] ?? null;
  const remote =
    localPath === null && typeof src === "string" && /^https?:\/\//i.test(src)
      ? src
      : null;
  const localUrl = useWorkspaceAssetUrl(localPath);
  const secureRemote = remote !== null && /^https:/i.test(remote);
  const image = useRemoteImage(secureRemote ? remote : null);
  const style = imageHeightStyle(props.height);

  if (localPath !== null) {
    return localUrl ? (
      <img {...props} style={style} src={localUrl} alt={alt} />
    ) : null;
  }
  if (remote === null) {
    return <img {...props} style={style} src={src} alt={alt} />;
  }
  if (secureRemote && image.status !== "failed") {
    return image.status === "ready" ? (
      <img {...props} style={style} src={image.url} alt={alt} />
    ) : null;
  }
  return (
    <span
      className="inline-block rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
      title={remote}
    >
      {alt ? `Image: ${alt}` : "Image"} (not loaded)
    </span>
  );
}
