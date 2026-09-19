// Header signature analyzer and source detection (Architecture §3.7, PRD §6.8).

import type { DetectionResult, SourceColumnConfig } from './types.js';
import type { ImportSource } from './index.js';

/**
 * Normalizes header string for case-insensitive matching.
 */
function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

/**
 * Evaluates how well a set of uploaded CSV headers matches a specific source configuration.
 */
export function scoreHeaderMatch(
  uploadedHeaders: string[],
  config: SourceColumnConfig,
): DetectionResult {
  const normalizedUploaded = new Set(uploadedHeaders.map(normalizeHeader));

  const missingRequired: string[] = [];
  const matchedRequired: string[] = [];

  for (const req of config.detection.requiredHeaders) {
    if (normalizedUploaded.has(normalizeHeader(req))) {
      matchedRequired.push(req);
    } else {
      missingRequired.push(req);
    }
  }

  // If any required header is missing, confidence is reduced or zero
  if (missingRequired.length > 0) {
    const penaltyRatio = matchedRequired.length / config.detection.requiredHeaders.length;
    return {
      source: config.source,
      confidence: Math.max(0, penaltyRatio * 0.4),
      matchedHeaders: matchedRequired,
      missingRequiredHeaders: missingRequired,
    };
  }

  // All required headers matched! Now check signature headers to score [0.7..1.0]
  const signatures = config.detection.signatureHeaders ?? [];
  let signatureMatches = 0;
  for (const sig of signatures) {
    if (normalizedUploaded.has(normalizeHeader(sig))) {
      signatureMatches++;
    }
  }

  const signatureBonus =
    signatures.length > 0 ? (signatureMatches / signatures.length) * 0.3 : 0.3;
  const confidence = Math.min(1.0, 0.7 + signatureBonus);

  return {
    source: config.source,
    confidence,
    matchedHeaders: matchedRequired,
    missingRequiredHeaders: [],
  };
}

/**
 * Automatically detects which source configuration matches the given CSV headers.
 */
export function detectSource(
  headers: string[],
  configs: SourceColumnConfig[],
): DetectionResult | null {
  if (!headers || headers.length === 0) return null;

  let bestMatch: DetectionResult | null = null;
  let highestConfidence = 0;

  for (const config of configs) {
    const result = scoreHeaderMatch(headers, config);
    const threshold = config.detection.minimumConfidence ?? 0.6;

    if (result.confidence >= threshold && result.confidence > highestConfidence) {
      highestConfidence = result.confidence;
      bestMatch = result;
    }
  }

  return bestMatch;
}

/**
 * Validates that an uploaded file's headers satisfy the requirements for the declared source.
 */
export function validateHeadersForSource(
  declaredSource: ImportSource,
  headers: string[],
  config: SourceColumnConfig,
): { valid: boolean; missing: string[]; confidence: number } {
  const result = scoreHeaderMatch(headers, config);
  return {
    valid: result.missingRequiredHeaders.length === 0,
    missing: result.missingRequiredHeaders,
    confidence: result.confidence,
  };
}
