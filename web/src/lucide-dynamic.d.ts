// Types shim for lucide-react's dynamic entry (0.577.0 exposes neither a
// `lucide-react/dynamic` subpath nor a .d.ts for the ESM build).
// DynamicIcon lazy-imports each icon → one same-origin chunk per
// icon (compatible with strict CSP, no CDN).
declare module "lucide-react/dist/esm/DynamicIcon.js" {
  import type { ForwardRefExoticComponent, RefAttributes } from "react";
  import type { LucideProps } from "lucide-react";

  /** List (kebab-case) of all available icon names. */
  export const iconNames: string[];

  const DynamicIcon: ForwardRefExoticComponent<
    Omit<LucideProps, "ref"> & { name: string } & RefAttributes<SVGSVGElement>
  >;
  export default DynamicIcon;
}
