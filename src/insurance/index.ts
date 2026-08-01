import { stubInsurance, type InsuranceApi } from '../contract.js';
import { insurance } from './stedi.js';

const hasStediKey = Boolean(process.env.STEDI_API_KEY?.trim());

export const insuranceApi: InsuranceApi = hasStediKey ? insurance : stubInsurance;
export const insuranceMode = hasStediKey
  ? process.env.STEDI_BASE_URL?.trim() ? 'mock' : 'stedi'
  : 'stub';
