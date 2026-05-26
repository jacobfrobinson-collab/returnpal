/**
 * Vision LLM valuation (OpenAI Chat Completions). Estimates only — not financial advice.
 * Env: OPENAI_API_KEY (required), OPENAI_MODEL (optional, default gpt-4o-mini for generic callers).
 * John Pye script passes OPENAI_JOHN_PYE_MODEL or sets gpt-4o for better small text on boxes.
 */
'use strict';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const SYSTEM_PROMPT = `You are a UK-focused resale research assistant. The user sends a lot title, optional text, and SEVERAL product IMAGES in gallery order. You will often see pallet/warehouse shots with many retail boxes. Your job is to be as *specific and exhaustive* as a human would be when reading every box, end-cap, and sticker in every frame.

Respond with a single JSON object only (no markdown). Use realistic GBP for UK RRP and typical private resale (eBay, Facebook Marketplace) for return/pallet/auction condition unless the photos clearly show new sealed items.

**productGuess (string — most important, can be long):** Work like an inventory taker, not a one-line summary.
1) Look at *every* image, in order. Information about different units is often in different photos (side label on one, front text on another).
2) *Enumerate every distinct visible unit* you can identify: each row should be a separate line or a clearly separated clause. A pallet of many printers is NOT "assorted printers" with one example; you must list *each* machine or *each* visible box/label, or state "×N" when several identical box fronts clearly show the same make/model.
3) *Read text on retail packaging* like OCR: if you can make out a full or partial product name, quote the exact wording (e.g. "PIXMA", "iX6850", "Smart Tank 5107", "Wireless", "DCP-…", "MFC-…") — these often appear on box sides and fronts. When you can read a model number, state it. When two photos show the same line with different details, say so.
4) If you see the same make/model on multiple boxes, write e.g. "Canon PIXMA / iX6850 — ≥4 box ends visible" or "HP Smart Tank 5107 (one box, front text legible); additional HP boxes present, model not read."
5) Only if text is genuinely unreadable, say *why* (angle, resolution, distance, glare) — do not use that as a shortcut to skip a thorough pass across all images.
6) **Never fabricate** full model numbers, serials, or barcodes. If you only see a logo, name the logo and "model not legible."

**packagingText (string, required — OCR / transcription first):** Before you summarise in productGuess, *transcribe* text you can read on box fronts, end flaps, stickers, and spines. Use a short line or bullet per distinct phrase: exact model codes (e.g. "iX6850", "Smart Tank 5107", "DCP-…", "MFC-…", "PIXMA"), "Wireless", capacity lines, and brand names. If a character is unclear, use "?" (e.g. "HP 51?7"). If nothing is readable, one sentence: why (blur, angle, distance). This field is the literal read-off; productGuess can then explain counts and the pallet as a whole.

**assumptions (string):** What is inferred (e.g. "two boxes likely same model from matching colours") vs directly read. **risks (string):** e.g. some units in shadow, not all 12 boxes individually readable.

**lineItems (array, required for downstream comp pricing):** For each *distinct* product you can use for an eBay “sold” search, one object. Used only for look-ups — not for inventing final GBP totals. Fields:
- searchQuery: short UK-focused eBay search string, e.g. "Canon PIXMA iX6850" or "HP Smart Tank" (no "pallet", "lot", "job lot"). If the *exact* model is unknown, still give the *best* product line you can (brand + line name). Broader eBay “sold” look-ups (e.g. brand + printer) run automatically in code if a narrow search has no usable sales.
- quantity: positive integer, best estimate of *visible* same-SKU units (1 if only one box read).
- source: "box_text" if model read from packaging; "inferred" if only from colours/branding; "uncertain" if you only know brand family.
- label: one-line human label (optional) for the CSV, e.g. "Canon A3 inkjet on box end".
- confidence0to100: how sure this query matches what is in the lot (0–100).
Omit or use empty lineItems if nothing is identifiable for search. Do not list duplicate searchQuery twice — merge quantities instead.

**Numeric (vision estimate — not replaced by eBay; kept for comparison):** rrpGbpLow, rrpGbpHigh, resaleGbpLow, resaleGbpHigh (or null), confidence0to100 (0–100; use lower if many items only partly visible).
Use null for numeric fields only if impossible; prefer wide ranges for mixed pallets.`;

function extractJsonObject(text) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const body = fence ? fence[1] : trimmed;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
        return JSON.parse(body.slice(start, end + 1));
    } catch {
        return null;
    }
}

/**
 * @param {{ title: string, metaDescription?: string, imageParts: Array<{ type: 'image_url', image_url: { url: string, detail?: string } }> }} input
 * @param {{ model?: string, apiKey?: string }} [opts]
 */
async function valueLotWithLlm(input, opts = {}) {
    const apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

    const model = opts.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const extraLines = opts.extraUserLines
        ? [].concat(opts.extraUserLines)
        : [];
    const preface = extraLines
        .map((l) => String(l).trim())
        .filter(Boolean)
        .join('\n\n');
    const userText =
        (preface ? preface + '\n\n' : '') +
        `Lot title: ${input.title || '(empty)'}\n` +
        `Page description snippet: ${(input.metaDescription || '').slice(0, 2000)}\n` +
        'You may receive up to 10+ images: use all of them before you conclude. Count units and name models that appear in any image. Output JSON only.';

    const userContent = [{ type: 'text', text: userText }, ...input.imageParts];

    const body = {
        model,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent },
        ],
        temperature: 0.15,
        max_tokens: 4000,
    };

    const res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    const raw = await res.text();
    if (!res.ok) {
        let msg = raw;
        try {
            const j = JSON.parse(raw);
            msg = j.error?.message || raw;
        } catch {
            /* ignore */
        }
        throw new Error(`OpenAI API ${res.status}: ${msg}`);
    }

    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        throw new Error('OpenAI returned non-JSON');
    }

    const text = data.choices?.[0]?.message?.content;
    const parsed = extractJsonObject(text);
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Model did not return parseable JSON');
    }

    return {
        rawText: text,
        valuation: {
            productGuess: String(parsed.productGuess ?? ''),
            packagingText: String(parsed.packagingText ?? ''),
            lineItems: normalizeLineItemsForComps(parsed.lineItems),
            rrpGbpLow: parsed.rrpGbpLow != null ? Number(parsed.rrpGbpLow) : null,
            rrpGbpHigh: parsed.rrpGbpHigh != null ? Number(parsed.rrpGbpHigh) : null,
            resaleGbpLow: parsed.resaleGbpLow != null ? Number(parsed.resaleGbpLow) : null,
            resaleGbpHigh: parsed.resaleGbpHigh != null ? Number(parsed.resaleGbpHigh) : null,
            confidence0to100: Math.min(100, Math.max(0, Math.round(Number(parsed.confidence0to100) || 0))),
            assumptions: String(parsed.assumptions ?? ''),
            risks: String(parsed.risks ?? ''),
        },
    };
}

const LINE_SOURCE = new Set(['box_text', 'inferred', 'uncertain']);

/**
 * @param {unknown} raw
 * @returns {Array<{ searchQuery: string, quantity: number, source: string, label: string, confidence0to100: number }>}
 */
function normalizeLineItemsForComps(raw) {
    if (!Array.isArray(raw) || !raw.length) {
        return [];
    }
    const byKey = new Map();
    for (const o of raw) {
        if (!o || typeof o !== 'object') {
            continue;
        }
        const q = String(o.searchQuery || '')
            .replace(/\s+/g, ' ')
            .trim();
        if (!q || q.length < 2) {
            continue;
        }
        const n = Math.max(1, Math.min(500, Math.floor(Number(o.quantity) || 1) || 1));
        const src = LINE_SOURCE.has(String(o.source)) ? String(o.source) : 'inferred';
        const label = String(o.label || '')
            .replace(/\s+/g, ' ')
            .trim();
        const conf = Math.min(100, Math.max(0, Math.round(Number(o.confidence0to100) || 60)));
        const k = q.toLowerCase();
        if (byKey.has(k)) {
            const p = byKey.get(k);
            p.quantity = Math.min(500, p.quantity + n);
            p.confidence0to100 = Math.max(p.confidence0to100, conf);
            if (label && !p.label) {
                p.label = label;
            }
        } else {
            byKey.set(k, { searchQuery: q, quantity: n, source: src, label, confidence0to100: conf });
        }
    }
    return Array.from(byKey.values());
}

/**
 * @param {Array<{ mimeType: string, base64: string }>} images
 * @param {{ imageDetail?: 'low' | 'high', maxImages?: number }} [opts]
 * maxImages defaults to 10 (cap 20). Use with John Pye after fetching many lot photos.
 */
function imagePartsFromBuffers(images, opts = {}) {
    const d = opts.imageDetail || process.env.OPENAI_IMAGE_DETAIL || 'low';
    const detail = d === 'high' ? 'high' : 'low';
    const cap = Math.min(20, Math.max(1, opts.maxImages == null ? 10 : Number(opts.maxImages) || 10));
    const parts = [];
    for (const img of images.slice(0, cap)) {
        if (!img?.base64 || !img?.mimeType) continue;
        const url = `data:${img.mimeType};base64,${img.base64}`;
        parts.push({
            type: 'image_url',
            image_url: { url, detail },
        });
    }
    return parts;
}

module.exports = {
    valueLotWithLlm,
    imagePartsFromBuffers,
    extractJsonObject,
    SYSTEM_PROMPT,
    normalizeLineItemsForComps,
};
