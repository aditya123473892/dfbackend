import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { CreateUserDto } from 'src/users/dtos';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dtos';
import { UsersService } from 'src/users/users.service';
import { AuthService } from './auth.service';
import { EBlockedByEnum, ERole } from 'src/common/enums';
import {
  badRequestRes,
  successRes,
  unAuthorizedRes,
} from 'src/common/interceptors';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { isMobileClient, JwtAuthGuard, RolesGuard } from 'src/common/guards';
import { otpError } from './otp/otp-errors';
import { AuthUser, Roles } from 'src/common/decorators';
import { IAuthUser } from 'src/common/interfaces';
import { decrypt, encrypt } from 'src/common/functions';
import { MailService } from 'src/mail/mail.service';
import { ConfigService } from '@nestjs/config';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly userService: UsersService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
  ) {}

  @Post('login')
  async login(@Body() credentials: LoginDto, @Req() request?: any) {
    // Mobile signs in with phone OTP only; existing users use /auth/phone/bootstrap once.
    if (isMobileClient(request)) throw otpError('PHONE_LOGIN_REQUIRED');

    const foundUser = await this.userService.findByUsername(
      credentials.username,
    );

    if (!foundUser) {
      return badRequestRes('Account does not exist with this email!');
    }

    if (!foundUser.isEmailVerified) {
      return badRequestRes(
        `Your account isn't verified yet, Please check your email.`,
      );
    }

    // Check if user is blocked
    if (foundUser.isBlocked) {
      //TODO: Check if unblock time is availale if blockedBy is SYSTEM
      const message =
        foundUser.blockedBy === EBlockedByEnum.SYSTEM
          ? 'Your account has been blocked by system, please try again after sometimes'
          : `You account has been blocked by ${foundUser.blockedBy}!. Contact support team.`;
      return badRequestRes(message);
    }

    let user = await this.authService.validateUser(
      credentials.username,
      credentials.password,
    );

    //Login Failed
    if (!user) {
      // TODO: Increment login attempts and if its 3 block user by SYSTEM
      // Block user if login attempts are already 2
      if (user.loginAttempts === 2) {
        await this.userService.blockUserBySystem(user._id);
      } else {
        await this.userService.updateLoginAttempts(
          user._id,
          user.loginAttempts + 1,
        );
      }

      return badRequestRes('Invalid username or password');
    }

    // Create Token
    // The response presenter may expose self-only fields only after authentication.
    if (request) request.user = { id: String(user._id) };
    const { accessToken, cookieToken } =
      await this.authService.createTokens(user);

    // increment login count update last login IP check login IP
    await this.userService.updateLoginInfo(user._id);

    // const finalUser

    return successRes({
      user: foundUser,
      accessToken,
    });
  }

  @Post('signup')
  async signUp(@Body() createUserDto: CreateUserDto, @Req() request?: any) {
    // Mobile signups verify the phone first: /auth/otp/signup/verify then /auth/otp/signup.
    if (isMobileClient(request)) throw otpError('PHONE_LOGIN_REQUIRED');
    try {
      const foundUser = await this.userService.findByUsername(
        createUserDto.username,
      );

      if (foundUser) {
        return badRequestRes(
          'Account already exists with this email!, go to login',
        );
      }

      // extract display name from username

      const displayname = createUserDto.username.split('@')[0];

      // Create user
      const user = await this.userService.create({
        username: createUserDto.username,
        password: createUserDto.password,
        firstName: createUserDto.firstName,
        lastName: createUserDto.lastName,
        age: createUserDto.age,
        gender: createUserDto.gender,
        phoneNumber: createUserDto.phoneNumber,
        roles: [ERole.USER],
        isEmailVerified: false,
        passwordResetToken: undefined,
        passwordResetTokenUsed: false,
        displayname,
      });

      if (!user) badRequestRes('Failed to signup!');

      // Generate email verification token valid for 3 days
      const currentDate = new Date();
      const expiryDate = new Date(currentDate);
      expiryDate.setDate(currentDate.getDate() + 3);

      const payload = `${user.username}_${expiryDate.toISOString()}`;

      const token = await encrypt(
        payload,
        process.env.PASSWORD_ENCRYPTION_PRIVATE_KEY,
      );

      // const url = `${process.env.PUBLIC_SITE_DOMAIN}/verify-email?token=${token}`;

      //TODO: Send email here
      const sendEmail = await this.mailService.verifyAccount(
        user.username,
        user.firstName,
        // url,
      );
      // Mock email verification in development
      if (
        !process.env.AWS_ACCESS_KEY ||
        !process.env.AWS_SECRET ||
        !process.env.AWS_SES_REGION
      ) {
        await this.userService.updateOne(user._id.toString(), {
          isEmailVerified: true,
        });
      }

      if (!sendEmail) return badRequestRes(`Unable to verification email`);

      return successRes({
        message: 'Account created, Please check your email and verify!',
      });
    } catch (error) {
      throw new Error(error);
    }
  }

  @Post('verify-email')
  async verifyEmail(@Body() { token }: VerifyEmailDto) {
    try {
      const decryptedToken = await decrypt(
        token,
        this.configService.get<string>('PASSWORD_ENCRYPTION_PRIVATE_KEY'),
      );

      const [username, expiryDate] = decryptedToken.split('_');

      if (new Date(expiryDate) < new Date())
        return badRequestRes(
          `Your email verification token is expired, Please try again!`,
          null,
          'TokenExpired',
        );

      const foundUser = await this.userService.findByUsername(username);

      if (!foundUser)
        return badRequestRes('User not found!', null, 'UserNotFound');

      if (foundUser.isEmailVerified) return successRes('Email verified!');

      const updatedUser = await this.userService.updateOne(
        foundUser._id.toString(),
        {
          isEmailVerified: true,
        },
      );

      return updatedUser.isEmailVerified
        ? successRes('Email verified successfully!')
        : badRequestRes('Failed to verify email');
    } catch (error) {
      throw new Error(error);
    }
  }

  @Post('forgot-password')
  async forgotPassword(@Body() { username }: ForgotPasswordDto) {
    const user = await this.userService.findOne({ username });

    const accepted = () => successRes(
      { passwordRequest: true }, 'If an account exists, reset instructions have been sent.',
    );
    if (!user || user.isBlocked || user.deletionRequestedAt) return accepted();

    //TODO: Generate a token for user with expiry
    const currentDate = new Date();
    const expiryDate = new Date(currentDate);
    expiryDate.setDate(currentDate.getDate() + 1);

    const payload = `${username}_${expiryDate.toISOString()}`;

    const token = await encrypt(
      payload,
      this.configService.get<string>('PASSWORD_ENCRYPTION_PRIVATE_KEY'),
    );

    // TODO: Save this token user_pwd_reset
    const updateUser = await this.userService.updateOne(user.id, {
      passwordResetToken: token,
      passwordResetTokenUsed: false,
    });

    if (!updateUser)
      return badRequestRes(`Unable to generate auth token`, {
        errorCode: 'failed_to_generate_auth_token',
      });

    const url = `${process.env.PUBLIC_SITE_DOMAIN}/reset-password?token=${token}`;

    // Send email here
    const SendEmail = await this.mailService.resetPassword(
      user.username,
      user.firstName,
      url,
    );

    if (!SendEmail) return badRequestRes(`Unable to send link`);

    return accepted();
  }

  @Post('reset-password')
  async resetPassword(@Body() { password, token }: ResetPasswordDto) {
    try {
      const decryptedToken = await decrypt(
        token,
        this.configService.get<string>('PASSWORD_ENCRYPTION_PRIVATE_KEY'),
      );

      const [username, expiryDate] = decryptedToken.split('_');

      const user = await this.userService.findOne({ username });

      if (!user)
        return badRequestRes(
          `No user exist with this '${username}' username or email!`,
        );

      if (user.passwordResetToken !== token)
        return badRequestRes(`Invalid auth token`, {
          errorCode: 'invalid_auth_token',
        });

      if (user.isBlocked) return badRequestRes(`Account blocked!`);

      if (new Date(expiryDate) < new Date())
        return badRequestRes(
          `Your password request token is expired, Please try again!`,
        );

      const updateUser = await this.userService.updatePassword(
        user.id,
        password,
      );

      if (!updateUser) return badRequestRes(`Unable to update user password`);

      return successRes(
        { resetPassword: true },
        'Password updated successfully',
      );
    } catch (error) {
      throw new Error('Invalid Token');
    }
  }

  @Post('send-verification-email')
  async resendVerificationEmail(@Body() { token }: VerifyEmailDto) {
    try {
      const decryptedToken = await decrypt(
        token,
        this.configService.get<string>('PASSWORD_ENCRYPTION_PRIVATE_KEY'),
      );

      const [username, expiryDate] = decryptedToken.split('_');

      if (new Date(expiryDate) < new Date())
        return badRequestRes(
          `Your email verification token is expired, Please try again!`,
          null,
          'TokenExpired',
        );

      const foundUser = await this.userService.findByUsername(username);

      if (!foundUser)
        return badRequestRes('User not found!', null, 'UserNotFound');

      if (foundUser.isEmailVerified) return successRes('Email verified!');

      const updatedUser = await this.userService.updateOne(
        foundUser._id.toString(),
        {
          isEmailVerified: true,
        },
      );

      return updatedUser.isEmailVerified
        ? successRes('Email verified successfully!')
        : badRequestRes('Failed to verify email');
    } catch (error) {
      throw new Error(error);
    }
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  async changePassword(
    @Body() changePasswordDto: ChangePasswordDto,
    @AuthUser() authUser: IAuthUser,
  ) {
    if (changePasswordDto.newPassword !== changePasswordDto.confirmNewPassword)
      return badRequestRes('New and Confirm password do not match!');

    const foundUser = await this.userService.findById(authUser.id);

    let user = await this.authService.validateUser(
      foundUser.username,
      changePasswordDto.oldPassword,
    );

    if (!user)
      return badRequestRes('Incorrect old password!, Please try again');

    const updatedUser = await this.userService.updatePassword(
      authUser.id,
      changePasswordDto.newPassword,
    );

    if (!updatedUser) return badRequestRes('Failed to update password!');

    // Create Token
    const { accessToken } = await this.authService.createTokens(user);

    return successRes(
      {
        user: updatedUser,
        accessToken,
      },
      'Password changed!',
    );
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getMe(@AuthUser() auth: IAuthUser) {
    const user = await this.userService.findById(auth.id);

    if (!user) return unAuthorizedRes('Unauthrorised! Please login');

    if (user.isBlocked)
      return unAuthorizedRes(
        'Account blocked!, contact administrator Dark Fantasy',
      );

    return successRes(user);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(ERole.ADMIN)
  @Get('/loginCheck')
  async loginCheck(@AuthUser() user: any) {
    return successRes({ user });
  }
}
