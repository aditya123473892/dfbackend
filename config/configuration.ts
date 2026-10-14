// import * as dotenv from 'dotenv';
// dotenv.config(); // Load environment variables from .env file
export default () => ({
  port: parseInt(process.env.PORT, 10) || 3000,
  telegram_app_id: parseInt(process.env.TELEGRAM_APP_ID),
});
