import { createContext, useContext } from "react";

import type { HostContext } from "@/lib/filter";

/** Host page a linked-database block is embedded in, exposed to `dbview` blocks
 * so their filters can reference the current page's own values. Null on plain
 * pages (page that is not a database row). */
export const InlineDbHostContext = createContext<HostContext | null>(null);

export const useInlineDbHost = (): HostContext | null => useContext(InlineDbHostContext);
