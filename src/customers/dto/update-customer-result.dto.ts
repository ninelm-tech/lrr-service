import { CustomerDto } from './customer.dto';

export interface UpdateCustomerResult {
  customer: CustomerDto;
  /** Field names only — never the values, which are personal data. */
  changedFields: Array<'name' | 'email'>;
}
