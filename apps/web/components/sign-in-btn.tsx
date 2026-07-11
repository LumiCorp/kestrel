import { headers } from "next/headers";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { Button } from "./ui/button";

export async function SignInButton() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  return (
    <Link
      className="flex justify-center"
      href={session?.session ? "/" : "/sign-in"}
    >
      <Button className="justify-between gap-2" variant="default">
        {session?.session ? (
          <svg
            aria-label="Home"
            height="1.2em"
            viewBox="0 0 24 24"
            width="1.2em"
            xmlns="http://www.w3.org/2000/svg"
          >
            <title>Home</title>
            <path d="M2 3h20v18H2zm18 16V7H4v12z" fill="currentColor" />
          </svg>
        ) : (
          <svg
            aria-label="Sign In"
            height="1.2em"
            viewBox="0 0 24 24"
            width="1.2em"
            xmlns="http://www.w3.org/2000/svg"
          >
            <title>Sign In</title>
            <path
              d="M5 3H3v4h2V5h14v14H5v-2H3v4h18V3zm12 8h-2V9h-2V7h-2v2h2v2H3v2h10v2h-2v2h2v-2h2v-2h2z"
              fill="currentColor"
            />
          </svg>
        )}
        <span>{session?.session ? "Home" : "Sign In"}</span>
      </Button>
    </Link>
  );
}

function checkOptimisticSession(requestHeaders: Headers) {
  const guessIsSignIn =
    requestHeaders.get("cookie")?.includes("better-auth.session") ||
    requestHeaders
      .get("cookie")
      ?.includes("__Secure-better-auth.session-token");
  return !!guessIsSignIn;
}

export async function SignInFallback() {
  //to avoid flash of unauthenticated state
  const guessIsSignIn = checkOptimisticSession(await headers());
  return (
    <Link
      className="flex justify-center"
      href={guessIsSignIn ? "/" : "/sign-in"}
    >
      <Button className="justify-between gap-2" variant="default">
        {guessIsSignIn ? (
          <svg
            aria-label="Home"
            height="1.2em"
            viewBox="0 0 24 24"
            width="1.2em"
            xmlns="http://www.w3.org/2000/svg"
          >
            <title>Home</title>
            <path d="M2 3h20v18H2zm18 16V7H4v12z" fill="currentColor" />
          </svg>
        ) : (
          <svg
            aria-label="Sign In"
            height="1.2em"
            viewBox="0 0 24 24"
            width="1.2em"
            xmlns="http://www.w3.org/2000/svg"
          >
            <title>Sign In</title>
            <path
              d="M5 3H3v4h2V5h14v14H5v-2H3v4h18V3zm12 8h-2V9h-2V7h-2v2h2v2H3v2h10v2h-2v2h2v-2h2v-2h2z"
              fill="currentColor"
            />
          </svg>
        )}
        <span>{guessIsSignIn ? "Home" : "Sign In"}</span>
      </Button>
    </Link>
  );
}
