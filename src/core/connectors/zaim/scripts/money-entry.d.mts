// money-entry.mjs の型（テストから使う部分だけ。allowJs を有効にしていないため、ここが唯一の型情報になる）
import type { ZaimRawMoneyEntry } from "../types.ts"

export function toRawEntry(item: Record<string, unknown>): Omit<ZaimRawMoneyEntry, "detail">
export function listItemKeys(items: unknown): string[]
export function fetchDetails(detailsUrl: string): Promise<unknown>
export function fetchEditPage(editUrl: string): Promise<{ ok: boolean; status: number; html?: string }>
export function readDetail(page: unknown, item: unknown, raw: unknown): Promise<unknown>
