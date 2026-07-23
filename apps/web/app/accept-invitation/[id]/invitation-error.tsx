import { AlertCircle } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function InvitationError({
  detail,
  signInHref,
}: {
  detail?: string;
  signInHref?: string;
}) {
  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <div className="flex items-center space-x-2">
          <AlertCircle className="h-6 w-6 text-destructive" />
          <CardTitle className="text-destructive text-xl">
            Invitation Error
          </CardTitle>
        </div>
        <CardDescription>
          There was an issue with your invitation.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-muted-foreground text-sm">
          {detail ||
            "The invitation you're trying to access is either invalid or you don't have the correct permissions. Please check your email for a valid invitation or contact the person who sent it."}
        </p>
      </CardContent>
      <CardFooter>
        <Button asChild className="w-full" variant="outline">
          <Link href={signInHref || "/"}>
            {signInHref ? "Switch account" : "Go back to home"}
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}
