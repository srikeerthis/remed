import { stubInsurance, type CoverageCheckInput, type InsuranceApi } from '../contract.js';
import { insurance as stediInsurance } from './stedi.js';

const hasStediKey = Boolean(process.env.STEDI_API_KEY?.trim());
const hasMockOverride = Boolean(process.env.STEDI_BASE_URL?.trim());

export const insuranceMode: 'stub' | 'mock' | 'stedi' = hasStediKey
  ? (hasMockOverride ? 'mock' : 'stedi')
  : 'stub';

/**
 * When a per-medication scenario is passed, the stub answers — this is how the
 * demo rehearses covered / high-copay / not-covered / prior-auth / deductible
 * / payer-error without a real payer. Real Stedi (mode === 'stedi') always
 * wins, since a live 271 must never be shadowed by a canned response.
 */
export const insuranceApi: InsuranceApi = {
  async checkCoverage(input: CoverageCheckInput) {
    if (input.scenario && insuranceMode !== 'stedi') {
      return stubInsurance.checkCoverage(input);
    }
    if (hasStediKey) return stediInsurance.checkCoverage(input);
    return stubInsurance.checkCoverage(input);
  },
};
