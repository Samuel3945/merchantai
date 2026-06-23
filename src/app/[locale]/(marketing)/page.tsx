import { redirect } from 'next/navigation';

// The public marketing landing was retired — it now lives on the standalone
// site (mymerchantai.com / pagemerchantai). This app root only routes users
// into the product. Auth (sign-in / sign-up) is unchanged; logged-out users
// sent to /dashboard are bounced to sign-in by the middleware.
export default function Index() {
  redirect('/dashboard');
}
