import { getEncoding } from 'js-tiktoken'

let enc: ReturnType<typeof getEncoding> | null = null

function getEnc() {
  if (!enc) enc = getEncoding('cl100k_base')
  return enc
}

export function countTokens(text: string): number {
  try {
    return getEnc().encode(text).length
  } catch {
    return Math.ceil(text.length / 4)
  }
}

export function estimateCost(tokens: number, modelPricePerMillion = 3.0): number {
  return (tokens / 1_000_000) * modelPricePerMillion
}

export function projectedSavingsAt1M(savedTokens: number, pricePerMillion = 3.0): number {
  return savedTokens * 1_000_000 * (pricePerMillion / 1_000_000)
}
