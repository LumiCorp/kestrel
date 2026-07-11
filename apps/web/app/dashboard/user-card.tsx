"use client";

import { MobileIcon } from "@radix-ui/react-icons";
import {
  Edit,
  Fingerprint,
  Laptop,
  Loader2,
  LogOut,
  Plus,
  QrCode,
  ShieldCheck,
  ShieldOff,
  StopCircle,
  Trash,
  X,
} from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import QRCode from "react-qr-code";
import { toast } from "sonner";
import { UAParser } from "ua-parser-js";
import { PasswordInput } from "@/components/password-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import CopyButton from "@/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { client, signOut, useSession } from "@/lib/auth-client";
import type { SerializedSessionRecord, Session } from "@/lib/auth-types";

function TwoFactorSection({ session }: { session: Session | null }) {
  const [isPendingTwoFa, setIsPendingTwoFa] = useState<boolean>(false);
  const [twoFaPassword, setTwoFaPassword] = useState<string>("");
  const [twoFactorDialog, setTwoFactorDialog] = useState<boolean>(false);
  const [twoFactorVerifyURI, setTwoFactorVerifyURI] = useState<string>("");
  const twoFactorEnabled = !!(session?.user as { twoFactorEnabled?: boolean })
    ?.twoFactorEnabled;

  const handleTwoFactorToggle = async () => {
    if (twoFaPassword.length < 8 && !twoFactorVerifyURI) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setIsPendingTwoFa(true);
    if (twoFactorEnabled) {
      await client.twoFactor.disable({
        password: twoFaPassword,
        fetchOptions: {
          onError(context: any) {
            toast.error(context.error.message);
          },
          onSuccess() {
            toast("2FA disabled successfully");
            setTwoFactorDialog(false);
          },
        },
      });
    } else {
      if (twoFactorVerifyURI) {
        await client.twoFactor.verifyTotp({
          code: twoFaPassword,
          fetchOptions: {
            onError(context: any) {
              setIsPendingTwoFa(false);
              setTwoFaPassword("");
              toast.error(context.error.message);
            },
            onSuccess() {
              toast("2FA enabled successfully");
              setTwoFactorVerifyURI("");
              setIsPendingTwoFa(false);
              setTwoFaPassword("");
              setTwoFactorDialog(false);
            },
          },
        });
        return;
      }
      await client.twoFactor.enable({
        password: twoFaPassword,
        fetchOptions: {
          onError(context: any) {
            toast.error(context.error.message);
          },
          onSuccess(ctx: any) {
            setTwoFactorVerifyURI(ctx.data.totpURI);
          },
        },
      });
    }
    setIsPendingTwoFa(false);
    setTwoFaPassword("");
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">Two Factor</p>
      <div className="flex gap-2">
        {twoFactorEnabled && (
          <Dialog>
            <DialogTrigger asChild>
              <Button className="gap-2" variant="outline">
                <QrCode size={16} />
                <span className="text-xs md:text-sm">Scan QR Code</span>
              </Button>
            </DialogTrigger>
            <DialogContent className="w-11/12 sm:max-w-[425px]">
              <DialogHeader>
                <DialogTitle>Scan QR Code</DialogTitle>
                <DialogDescription>
                  Scan the QR code with your TOTP app
                </DialogDescription>
              </DialogHeader>

              {twoFactorVerifyURI ? (
                <>
                  <div className="flex items-center justify-center">
                    <QRCode value={twoFactorVerifyURI} />
                  </div>
                  <div className="flex items-center justify-center gap-2">
                    <p className="text-muted-foreground text-sm">
                      Copy URI to clipboard
                    </p>
                    <CopyButton textToCopy={twoFactorVerifyURI} />
                  </div>
                </>
              ) : (
                <div className="flex flex-col gap-2">
                  <PasswordInput
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setTwoFaPassword(e.target.value)
                    }
                    placeholder="Enter Password"
                    value={twoFaPassword}
                  />
                  <Button
                    onClick={async () => {
                      if (twoFaPassword.length < 8) {
                        toast.error("Password must be at least 8 characters");
                        return;
                      }
                      await client.twoFactor.getTotpUri(
                        {
                          password: twoFaPassword,
                        },
                        {
                          onSuccess(context: any) {
                            setTwoFactorVerifyURI(context.data.totpURI);
                          },
                        }
                      );
                      setTwoFaPassword("");
                    }}
                  >
                    Show QR Code
                  </Button>
                </div>
              )}
            </DialogContent>
          </Dialog>
        )}
        <Dialog onOpenChange={setTwoFactorDialog} open={twoFactorDialog}>
          <DialogTrigger asChild>
            <Button
              className="gap-2"
              variant={twoFactorEnabled ? "destructive" : "outline"}
            >
              {twoFactorEnabled ? (
                <ShieldOff size={16} />
              ) : (
                <ShieldCheck size={16} />
              )}
              <span className="text-xs md:text-sm">
                {twoFactorEnabled ? "Disable 2FA" : "Enable 2FA"}
              </span>
            </Button>
          </DialogTrigger>
          <DialogContent className="w-11/12 sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>
                {twoFactorEnabled ? "Disable 2FA" : "Enable 2FA"}
              </DialogTitle>
              <DialogDescription>
                {twoFactorEnabled
                  ? "Disable the second factor authentication from your account"
                  : "Enable 2FA to secure your account"}
              </DialogDescription>
            </DialogHeader>

            {twoFactorVerifyURI ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-center">
                  <QRCode value={twoFactorVerifyURI} />
                </div>
                <Label htmlFor="password">
                  Scan the QR code with your TOTP app
                </Label>
                <Input
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setTwoFaPassword(e.target.value)
                  }
                  placeholder="Enter OTP"
                  value={twoFaPassword}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">Password</Label>
                <PasswordInput
                  id="password"
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setTwoFaPassword(e.target.value)
                  }
                  placeholder="Password"
                  value={twoFaPassword}
                />
              </div>
            )}
            <DialogFooter>
              <Button disabled={isPendingTwoFa} onClick={handleTwoFactorToggle}>
                {(() => {
                  if (isPendingTwoFa) {
                    return <Loader2 className="animate-spin" size={15} />;
                  }
                  if (twoFactorEnabled) {
                    return "Disable 2FA";
                  }
                  return "Enable 2FA";
                })()}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function ActiveSessionsSection({
  activeSessions,
  currentSessionId,
  onSessionRemove,
}: {
  activeSessions: SerializedSessionRecord[];
  currentSessionId?: string;
  onSessionRemove: (sessionId: string) => void;
}) {
  const router = useRouter();
  const [isTerminating, setIsTerminating] = useState<string>();

  const handleTerminateSession = async (session: SerializedSessionRecord) => {
    setIsTerminating(session.id);
    const res = await client.revokeSession({
      token: session.token,
    });

    if (res.error) {
      toast.error(res.error.message);
    } else {
      toast.success("Session terminated successfully");
      onSessionRemove(session.id);
    }
    if (session.id === currentSessionId) {
      router.refresh();
    }
    setIsTerminating(undefined);
  };

  return (
    <div className="flex w-max flex-col gap-1 border-l-2 px-2">
      <p className="font-medium text-xs">Active Sessions</p>
      {activeSessions
        .filter((s) => s.userAgent)
        .map((s) => (
          <div key={s.id}>
            <div className="flex items-center gap-2 font-medium text-black text-sm dark:text-white">
              {new UAParser(s.userAgent || "").getDevice().type === "mobile" ? (
                <MobileIcon />
              ) : (
                <Laptop size={16} />
              )}
              {new UAParser(s.userAgent || "").getOS().name || s.userAgent},{" "}
              {new UAParser(s.userAgent || "").getBrowser().name}
              <button
                className="cursor-pointer border-red-600 text-red-500 text-xs underline opacity-80"
                onClick={() => handleTerminateSession(s)}
                type="button"
              >
                {(() => {
                  if (isTerminating === s.id) {
                    return <Loader2 className="animate-spin" size={15} />;
                  }
                  if (s.id === currentSessionId) {
                    return "Sign Out";
                  }
                  return "Terminate";
                })()}
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}

export default function UserCard(props: {
  session: Session | null;
  activeSessions: SerializedSessionRecord[];
}) {
  const router = useRouter();
  const { data } = useSession();
  const session = data || props.session;
  const [isSignOut, setIsSignOut] = useState<boolean>(false);
  const [emailVerificationPending, setEmailVerificationPending] =
    useState<boolean>(false);
  const [activeSessions, setActiveSessions] = useState(props.activeSessions);
  const removeActiveSession = (sessionId: string) =>
    setActiveSessions(activeSessions.filter((s) => s.id !== sessionId));
  return (
    <Card>
      <CardHeader>
        <CardTitle>User</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-8">
        <div className="flex flex-col gap-2">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-4">
              <Avatar className="hidden h-9 w-9 sm:flex">
                <AvatarImage
                  alt="Avatar"
                  className="object-cover"
                  src={session?.user.image || undefined}
                />
                <AvatarFallback>{session?.user.name.charAt(0)}</AvatarFallback>
              </Avatar>
              <div className="grid">
                <p className="font-medium text-sm leading-none">
                  {session?.user.name}
                </p>
                <p className="text-sm">{session?.user.email}</p>
              </div>
            </div>
            <EditUserDialog />
          </div>
        </div>

        {session?.user.emailVerified ? null : (
          <Alert>
            <AlertTitle>Verify Your Email Address</AlertTitle>
            <AlertDescription className="text-muted-foreground">
              Please verify your email address. Check your inbox for the
              verification email. If you haven't received the email, click the
              button below to resend.
              <Button
                className="mt-2"
                onClick={async () => {
                  await client.sendVerificationEmail(
                    {
                      email: session?.user.email || "",
                    },
                    {
                      onRequest() {
                        setEmailVerificationPending(true);
                      },
                      onError(context: any) {
                        toast.error(context.error.message);
                        setEmailVerificationPending(false);
                      },
                      onSuccess() {
                        toast.success("Verification email sent successfully");
                        setEmailVerificationPending(false);
                      },
                    }
                  );
                }}
                size="sm"
                variant="secondary"
              >
                {emailVerificationPending ? (
                  <Loader2 className="animate-spin" size={15} />
                ) : (
                  "Resend Verification Email"
                )}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <ActiveSessionsSection
          activeSessions={activeSessions}
          currentSessionId={props.session?.session.id}
          onSessionRemove={removeActiveSession}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-y py-4">
          <div className="flex flex-col gap-2">
            <p className="text-sm">Passkeys</p>
            <div className="flex flex-wrap gap-2">
              <AddPasskey />
              <ListPasskeys />
            </div>
          </div>
          <TwoFactorSection session={session as Session | null} />
        </div>
      </CardContent>
      <CardFooter className="items-center justify-between gap-2">
        <ChangePassword />
        {(session?.session as { impersonatedBy?: string | null })
          ?.impersonatedBy ? (
          <Button
            className="z-10 gap-2"
            disabled={isSignOut}
            onClick={async () => {
              setIsSignOut(true);
              await client.admin.stopImpersonating();
              setIsSignOut(false);
              toast.info("Impersonation stopped successfully");
              router.push("/dashboard");
            }}
            variant="secondary"
          >
            <span className="text-sm">
              {isSignOut ? (
                <Loader2 className="animate-spin" size={15} />
              ) : (
                <div className="flex items-center gap-2">
                  <StopCircle color="red" size={16} />
                  Stop Impersonation
                </div>
              )}
            </span>
          </Button>
        ) : (
          <Button
            className="z-10 gap-2"
            disabled={isSignOut}
            onClick={async () => {
              setIsSignOut(true);
              await signOut({
                fetchOptions: {
                  onSuccess() {
                    router.push("/");
                  },
                },
              });
              setIsSignOut(false);
            }}
            variant="secondary"
          >
            <span className="text-sm">
              {isSignOut ? (
                <Loader2 className="animate-spin" size={15} />
              ) : (
                <div className="flex items-center gap-2">
                  <LogOut size={16} />
                  Sign Out
                </div>
              )}
            </span>
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

function convertImageToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function ChangePassword() {
  const [currentPassword, setCurrentPassword] = useState<string>("");
  const [newPassword, setNewPassword] = useState<string>("");
  const [confirmPassword, setConfirmPassword] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [open, setOpen] = useState<boolean>(false);
  const [signOutDevices, setSignOutDevices] = useState<boolean>(false);
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button className="z-10 gap-2" size="sm" variant="outline">
          <svg
            aria-label="Change Password"
            height="1em"
            viewBox="0 0 24 24"
            width="1em"
            xmlns="http://www.w3.org/2000/svg"
          >
            <title>Change Password</title>
            <path
              d="M2.5 18.5v-1h19v1zm.535-5.973l-.762-.442l.965-1.693h-1.93v-.884h1.93l-.965-1.642l.762-.443L4 9.066l.966-1.643l.761.443l-.965 1.642h1.93v.884h-1.93l.965 1.693l-.762.442L4 10.835zm8 0l-.762-.442l.966-1.693H9.308v-.884h1.93l-.965-1.642l.762-.443L12 9.066l.966-1.643l.761.443l-.965 1.642h1.93v.884h-1.93l.965 1.693l-.762.442L12 10.835zm8 0l-.762-.442l.966-1.693h-1.931v-.884h1.93l-.965-1.642l.762-.443L20 9.066l.966-1.643l.761.443l-.965 1.642h1.93v.884h-1.93l.965 1.693l-.762.442L20 10.835z"
              fill="currentColor"
            />
          </svg>
          <span className="text-muted-foreground text-sm">Change Password</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="w-11/12 sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Change Password</DialogTitle>
          <DialogDescription>Change your password</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="current-password">Current Password</Label>
          <PasswordInput
            autoComplete="new-password"
            id="current-password"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setCurrentPassword(e.target.value)
            }
            placeholder="Password"
            value={currentPassword}
          />
          <Label htmlFor="new-password">New Password</Label>
          <PasswordInput
            autoComplete="new-password"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setNewPassword(e.target.value)
            }
            placeholder="New Password"
            value={newPassword}
          />
          <Label htmlFor="password">Confirm Password</Label>
          <PasswordInput
            autoComplete="new-password"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setConfirmPassword(e.target.value)
            }
            placeholder="Confirm Password"
            value={confirmPassword}
          />
          <div className="flex items-center gap-2">
            <Checkbox
              onCheckedChange={(checked) =>
                checked ? setSignOutDevices(true) : setSignOutDevices(false)
              }
            />
            <p className="text-sm">Sign out from other devices</p>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={async () => {
              if (newPassword !== confirmPassword) {
                toast.error("Passwords do not match");
                return;
              }
              if (newPassword.length < 8) {
                toast.error("Password must be at least 8 characters");
                return;
              }
              setLoading(true);
              const res = await client.changePassword({
                newPassword,
                currentPassword,
                revokeOtherSessions: signOutDevices,
              });
              setLoading(false);
              if (res.error) {
                toast.error(
                  res.error.message ||
                    "Couldn't change your password! Make sure it's correct"
                );
              } else {
                setOpen(false);
                toast.success("Password changed successfully");
                setCurrentPassword("");
                setNewPassword("");
                setConfirmPassword("");
              }
            }}
          >
            {loading ? (
              <Loader2 className="animate-spin" size={15} />
            ) : (
              "Change Password"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog() {
  const { data } = useSession();
  const [name, setName] = useState<string>();
  const router = useRouter();
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setImage(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };
  const [open, setOpen] = useState<boolean>(false);
  const [isLoading, startTransition] = useTransition();
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button className="gap-2" size="sm" variant="secondary">
          <Edit size={13} />
          Edit User
        </Button>
      </DialogTrigger>
      <DialogContent className="w-11/12 sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Edit User</DialogTitle>
          <DialogDescription>Edit user information</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="name">Full Name</Label>
          <Input
            id="name"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setName(e.target.value);
            }}
            placeholder={data?.user.name}
            required
            type="name"
          />
          <div className="grid gap-2">
            <Label htmlFor="image">Profile Image</Label>
            <div className="flex items-end gap-4">
              {imagePreview && (
                <div className="relative h-16 w-16 overflow-hidden rounded-sm">
                  <Image
                    alt="Profile preview"
                    layout="fill"
                    objectFit="cover"
                    src={imagePreview}
                  />
                </div>
              )}
              <div className="flex w-full items-center gap-2">
                <Input
                  accept="image/*"
                  className="w-full text-muted-foreground"
                  id="image"
                  onChange={handleImageChange}
                  type="file"
                />
                {imagePreview && (
                  <X
                    className="cursor-pointer"
                    onClick={() => {
                      setImage(null);
                      setImagePreview(null);
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={isLoading}
            onClick={() => {
              startTransition(async () => {
                await client.updateUser({
                  image: image ? await convertImageToBase64(image) : undefined,
                  name: name ? name : undefined,
                  fetchOptions: {
                    onSuccess: () => {
                      toast.success("User updated successfully");
                    },
                    onError: (error: any) => {
                      toast.error(error.error.message);
                    },
                  },
                });
                startTransition(() => {
                  setName("");
                  router.refresh();
                  setImage(null);
                  setImagePreview(null);
                  setOpen(false);
                });
              });
            }}
          >
            {isLoading ? (
              <Loader2 className="animate-spin" size={15} />
            ) : (
              "Update"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddPasskey() {
  const [isOpen, setIsOpen] = useState(false);
  const [passkeyName, setPasskeyName] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleAddPasskey = async () => {
    if (!passkeyName) {
      toast.error("Passkey name is required");
      return;
    }
    setIsLoading(true);
    const res = await client.passkey.addPasskey({
      name: passkeyName,
    });
    if (res?.error) {
      toast.error(res?.error.message);
    } else {
      setIsOpen(false);
      toast.success("Passkey added successfully. You can now use it to login.");
    }
    setIsLoading(false);
  };
  return (
    <Dialog onOpenChange={setIsOpen} open={isOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2 text-xs md:text-sm" variant="outline">
          <Plus size={15} />
          Add New Passkey
        </Button>
      </DialogTrigger>
      <DialogContent className="w-11/12 sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Add New Passkey</DialogTitle>
          <DialogDescription>
            Create a new passkey to securely access your account without a
            password.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="passkey-name">Passkey Name</Label>
          <Input
            id="passkey-name"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setPasskeyName(e.target.value)
            }
            value={passkeyName}
          />
        </div>
        <DialogFooter>
          <Button
            className="w-full"
            disabled={isLoading}
            onClick={handleAddPasskey}
            type="submit"
          >
            {isLoading ? (
              <Loader2 className="animate-spin" size={15} />
            ) : (
              <>
                <Fingerprint className="mr-2 h-4 w-4" />
                Create Passkey
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ListPasskeys() {
  const { data } = client.useListPasskeys();
  const [isOpen, setIsOpen] = useState(false);
  const [passkeyName, setPasskeyName] = useState("");

  const handleAddPasskey = async () => {
    if (!passkeyName) {
      toast.error("Passkey name is required");
      return;
    }
    setIsLoading(true);
    const res = await client.passkey.addPasskey({
      name: passkeyName,
    });
    setIsLoading(false);
    if (res?.error) {
      toast.error(res?.error.message);
    } else {
      toast.success("Passkey added successfully. You can now use it to login.");
    }
  };
  const [isLoading, setIsLoading] = useState(false);
  const [isDeletePasskey, setIsDeletePasskey] = useState<boolean>(false);
  return (
    <Dialog onOpenChange={setIsOpen} open={isOpen}>
      <DialogTrigger asChild>
        <Button className="text-xs md:text-sm" variant="outline">
          <Fingerprint className="mr-2 h-4 w-4" />
          <span>Passkeys {data?.length ? `[${data?.length}]` : ""}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="w-11/12 sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Passkeys</DialogTitle>
          <DialogDescription>List of passkeys</DialogDescription>
        </DialogHeader>
        {data?.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((passkey: any) => (
                <TableRow
                  className="flex items-center justify-between"
                  key={passkey.id}
                >
                  <TableCell>{passkey.name || "My Passkey"}</TableCell>
                  <TableCell className="text-right">
                    <button
                      onClick={async () => {
                        await client.passkey.deletePasskey({
                          id: passkey.id,
                          fetchOptions: {
                            onRequest: () => {
                              setIsDeletePasskey(true);
                            },
                            onSuccess: () => {
                              toast("Passkey deleted successfully");
                              setIsDeletePasskey(false);
                            },
                            onError: (error: any) => {
                              toast.error(error.error.message);
                              setIsDeletePasskey(false);
                            },
                          },
                        });
                      }}
                      type="button"
                    >
                      {isDeletePasskey ? (
                        <Loader2 className="animate-spin" size={15} />
                      ) : (
                        <Trash
                          className="cursor-pointer text-red-600"
                          size={15}
                        />
                      )}
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-muted-foreground text-sm">No passkeys found</p>
        )}
        {!data?.length && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-2">
              <Label className="text-sm" htmlFor="passkey-name">
                New Passkey
              </Label>
              <Input
                id="passkey-name"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setPasskeyName(e.target.value)
                }
                placeholder="My Passkey"
                value={passkeyName}
              />
            </div>
            <Button className="w-full" onClick={handleAddPasskey} type="submit">
              {isLoading ? (
                <Loader2 className="animate-spin" size={15} />
              ) : (
                <>
                  <Fingerprint className="mr-2 h-4 w-4" />
                  Create Passkey
                </>
              )}
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button onClick={() => setIsOpen(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
