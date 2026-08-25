import { Schema, model, Document } from 'mongoose';

export type UserRole = 'viewer' | 'operator' | 'admin';

export interface IUser extends Document {
  email: string;
  name: string;
  passwordHash: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['viewer', 'operator', 'admin'], default: 'viewer' },
  },
  { timestamps: true },
);

export const User = model<IUser>('User', userSchema);
