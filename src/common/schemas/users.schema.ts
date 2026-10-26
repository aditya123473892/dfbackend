import { Schema, SchemaFactory, Prop } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { EBlockedByEnum, ERole } from '../enums';
import { genSalt, hash } from 'bcrypt';
import { EUserAccountStatus } from '../enums/users.enum';

export type UsersDocument = Users & Document;
@Schema({ timestamps: true, collection: 'Users' })
export class Users {
  // Written exclusively by verified server entitlement processing (never a user DTO).
  @Prop({ type: Date, default: null, select: false })
  premiumUntil?: Date;

  @Prop({ required: true, unique: true })
  username: string;

  @Prop({ required: true, select: false })
  password: string;

  // Profile information
  @Prop({ required: true, unique: true })
  displayname: string;

  @Prop({ required: true })
  firstName: string;

  @Prop({ required: true })
  lastName: string;

  // Legacy free-text value from web signup; never verified or unique.
  @Prop({ required: false })
  phoneNumber: string;

  // Set only together with phoneVerifiedAt after a Twilio Verify approval.
  // Unique via the operator-managed partial index phone_e164_unique.
  @Prop({ type: String, required: false })
  phoneE164?: string;

  @Prop({ type: Date, required: false })
  phoneVerifiedAt?: Date;

  @Prop({ required: false })
  gender: string;

  @Prop({ required: false })
  age: number;

  @Prop({ required: false })
  avatar: string;

  @Prop({ required: false })
  bio: string;

  @Prop({ required: false })
  posts: number;

  @Prop({ required: false })
  followers: number;

  @Prop({ required: false })
  following: number;

  // Auth and management
  @Prop({ default: false })
  isOnline: boolean;

  @Prop({ required: false })
  lastSeen: Date;

  @Prop({ required: false, default: false })
  isEmailVerified: boolean;

  @Prop({ required: true, default: 0 })
  loginCount: number;

  @Prop({ required: false })
  lastLogin: Date;

  @Prop({ required: true, default: 0, max: 5 })
  loginAttempts: number;

  @Prop({ required: true, default: false })
  isBlocked: boolean;

  @Prop({ type: String, required: true, enum: EBlockedByEnum, default: EBlockedByEnum.OPEN })
  blockedBy: EBlockedByEnum;

  @Prop({ type: String,
    required: true,
    enum: EUserAccountStatus,
    default: EUserAccountStatus.OPEN,
  })
  status: EUserAccountStatus;

  @Prop({ required: false })
  blockedTime: Date;

  @Prop({ required: false })
  moderationSuspendedUntil: Date;

  @Prop({ required: false })
  deletionRequestedAt: Date;

  @Prop({
    required: true,
    type: [String],
    enum: Object.values(ERole),
  })
  roles: ERole[];

  @Prop({ required: false })
  intrests: string[];

  @Prop({ required: false })
  passwordResetToken: string;

  @Prop({ default: false })
  passwordResetTokenUsed: boolean;

  @Prop({ required: false })
  verifyEmailToken: string;

  @Prop({ required: true, default: false })
  canEditProfile: boolean;

  @Prop({ required: false })
  city: string;

  @Prop({ required: false })
  state: string;

  @Prop({ required: false })
  country: string;
}

export const UsersSchema = SchemaFactory.createForClass(Users);

UsersSchema.pre('save', async function (next) {
  try {
    if (!this.isModified('password')) {
      return next();
    }
    const salt = await genSalt(10);

    const hashedPassword = await hash(this.password, salt);
    this.password = hashedPassword;
    next();
  } catch (error) {
    next(error);
  }
});

UsersSchema.post('save', function (doc, next) {
  doc.password = undefined; // Remove the password field
  next();
});
