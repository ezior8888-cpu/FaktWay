// Wywołanie Claude Vision API + parsowanie outputu

import type {
  Base64ImageSource,
  ContentBlockParam,
  DocumentBlockParam,
  ImageBlockParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';

import { getAnthropic, OCR_MODEL } from '@/lib/anthropic/client';
import { isAnthropicMocked } from '@/lib/test-mode';

import { fitImageForApi } from './image-for-api';
import { claudeOutputInstructions, extractedInvoiceSchema } from './schema';
import type { ExtractedInvoice } from './schema';

export interface OcrResult {
  success: boolean;
  data?: ExtractedInvoice;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  processingTimeMs: number;
  modelUsed: string;
}

const SYSTEM_PROMPT = `Jesteś ekspertem od polskich faktur VAT i paragonów. Twoim zadaniem jest precyzyjne ekstraktowanie strukturyzowanych danych ze zdjęć/skanów.

Specjalizujesz się w:
- Rozpoznawaniu polskich NIP (10 cyfr, walidacja mod-11)
- Rozumieniu polskiego formatu dat
- Stawek VAT zgodnych z polskim prawem (23%, 8%, 5%, 0%, zw, oo, np)
- Polskich nazw firm i ich form prawnych (Sp. z o.o., S.A., Sp. j.)
- Standardów paragonów fiskalnych i faktur VAT

Zawsze zwracaj JSON. Bądź konserwatywny - jeśli czegoś nie widzisz wyraźnie, daj null zamiast zgadywania.`;

function normalizeImageMediaType(
  mimeType: string
): Base64ImageSource['media_type'] | null {
  const m = mimeType.toLowerCase();
  if (m === 'image/jpg') return 'image/jpeg';
  if (
    m === 'image/jpeg' ||
    m === 'image/png' ||
    m === 'image/gif' ||
    m === 'image/webp'
  ) {
    return m;
  }
  return null;
}

async function buildUserContent(
  imageBase64: string,
  mimeType: string,
  textPrompt: string
): Promise<ContentBlockParam[]> {
  const lower = mimeType.toLowerCase();
  const textBlock: TextBlockParam = {
    type: 'text',
    text: textPrompt,
  };

  if (lower === 'application/pdf') {
    const doc: DocumentBlockParam = {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: imageBase64,
      },
    };
    return [doc, textBlock];
  }

  const media = normalizeImageMediaType(lower);
  if (!media) {
    throw new Error(`Nieobsługiwany typ obrazu: ${mimeType}`);
  }

  // Obraz ponad 8000 px API odrzuca: idzie kopia zmniejszona w pamięci,
  // mniejszy bez zmian (plan skalowania, sesja 34).
  const fitted = await fitImageForApi(imageBase64, media);
  const image: ImageBlockParam = {
    type: 'image',
    source: {
      type: 'base64',
      media_type: fitted.mediaType,
      data: fitted.data,
    },
  };
  return [image, textBlock];
}

export async function extractInvoiceFromImage(
  imageBase64: string,
  mimeType: string
): Promise<OcrResult> {
  const startTime = Date.now();
  const elapsed = () => Date.now() - startTime;

  if (isAnthropicMocked()) {
    // Deterministyczny stub dla E2E — kwota i NIP zgodne z `e2e/helpers/test-data.ts`.
    const stub: ExtractedInvoice = {
      seller_name: 'PKN Orlen S.A.',
      seller_nip: '7740001454',
      seller_address: 'ul. Chemików 7, 09-411 Płock',
      document_number: `E2E-OCR-${Date.now()}`,
      document_type: 'receipt',
      issue_date: new Date().toISOString().slice(0, 10),
      net_amount: 81.3,
      vat_amount: 18.7,
      gross_amount: 100.0,
      vat_rate: '23',
      line_items: [
        { name: 'Paliwo Pb95', quantity: 14.5, unit_price: 6.89, gross: 100.0 },
      ],
      ocr_confidence: 0.95,
      notes: null,
    };
    return {
      success: true,
      data: stub,
      inputTokens: 0,
      outputTokens: 0,
      processingTimeMs: elapsed(),
      modelUsed: `${OCR_MODEL}:e2e-mock`,
    };
  }

  const mimeOk =
    normalizeImageMediaType(mimeType) !== null ||
    mimeType.toLowerCase() === 'application/pdf';

  if (!mimeOk) {
    return {
      success: false,
      error: `Nieobsługiwany format pliku: ${mimeType}`,
      inputTokens: 0,
      outputTokens: 0,
      processingTimeMs: elapsed(),
      modelUsed: OCR_MODEL,
    };
  }

  try {
    const textPrompt = `Rozpoznaj fakturę/paragon na tym zdjęciu i zwróć strukturyzowane dane.\n\n${claudeOutputInstructions}`;
    const userContent = await buildUserContent(imageBase64, mimeType, textPrompt);

    const response = await getAnthropic().messages.create({
      model: OCR_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: userContent,
        },
      ],
    });

    const processingTimeMs = elapsed();

    const textBlock = response.content.find((c) => c.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return {
        success: false,
        error: 'Brak text response z Claude',
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        processingTimeMs,
        modelUsed: OCR_MODEL,
      };
    }

    const jsonText = textBlock.text
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/\s*```\s*$/m, '')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return {
        success: false,
        error: `Claude zwrócił nieprawidłowy JSON: ${jsonText.slice(0, 200)}`,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        processingTimeMs,
        modelUsed: OCR_MODEL,
      };
    }

    const validation = extractedInvoiceSchema.safeParse(parsed);
    if (!validation.success) {
      return {
        success: false,
        error: `Schema validation: ${validation.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        processingTimeMs,
        modelUsed: OCR_MODEL,
      };
    }

    return {
      success: true,
      data: validation.data,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      processingTimeMs,
      modelUsed: OCR_MODEL,
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : 'Nieznany błąd OCR',
      inputTokens: 0,
      outputTokens: 0,
      processingTimeMs: elapsed(),
      modelUsed: OCR_MODEL,
    };
  }
}
