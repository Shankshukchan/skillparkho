import Joi from 'joi';
import { normalizePhoneNumber } from './phoneNormalizer.js';

export const verifiedContactSchema = Joi.object({
  phone_number: Joi.string().required().custom((value, helpers) => {
    const norm = normalizePhoneNumber(value);
    if (!/^\d{10}$/.test(norm)) {
      return helpers.error('any.invalid');
    }
    return value;
  }, 'phone normalization').messages({ 'any.invalid': 'phone_number must be a valid 10-digit Indian number' }),
  hr_name: Joi.string().trim().min(2).max(100).required(),
  company_name: Joi.string().trim().min(1).max(120).required(),
  location: Joi.string().trim().max(150).allow('', null).default(''),
  hr_designation: Joi.string().trim().max(120).allow('', null).default(''),
  job_position_called_for: Joi.string().trim().max(120).allow('', null).default('Other'),
  email: Joi.string().email().allow('', null).default(null),
  verified: Joi.boolean().default(true),
  verification_status: Joi.string().valid('verified', 'pending', 'rejected', 'expired').default('verified'),
  source: Joi.string().valid('admin_upload', 'bulk_import', 'api', 'manual').default('admin_upload'),
  notes: Joi.string().max(500).allow('', null).default(null),
});

export const bulkUploadSchema = Joi.object({
  contacts: Joi.array().items(verifiedContactSchema).min(1).max(1000).required(),
});

export const allowedUserSchema = Joi.object({
  phone_number: Joi.string().required().custom((value, helpers) => {
    const norm = normalizePhoneNumber(value);
    if (!/^\d{10}$/.test(norm)) return helpers.error('any.invalid');
    return value;
  }, 'phone normalization').messages({ 'any.invalid': 'phone_number must be a valid 10-digit Indian number' }),
  email: Joi.string().email().required().messages({ 'string.email': 'valid email required' }),
  full_name: Joi.string().trim().max(100).allow('', null).default(''),
  is_active: Joi.boolean().default(true),
});

export function validateVerifiedContact(data) {
  return verifiedContactSchema.validate(data, { abortEarly: false, stripUnknown: true });
}

export function validateBulkContacts(data) {
  return bulkUploadSchema.validate(data, { abortEarly: false, stripUnknown: true });
}

export function validateAllowedUser(data) {
  return allowedUserSchema.validate(data, { abortEarly: false, stripUnknown: true });
}
