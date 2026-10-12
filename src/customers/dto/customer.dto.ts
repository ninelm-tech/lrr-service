export interface CustomerDto {
  id: string;
  email: string | null;
  phoneNumber: string | null;
  name: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
