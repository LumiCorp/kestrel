import { ArrowUpFromLine, CreditCard, RefreshCcw } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { client } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

function getButtonText(
  selectedPlan: string,
  currentPlan?: string,
  isTrial?: boolean
): string {
  const currentPlanLower = currentPlan?.toLowerCase();
  if (selectedPlan === currentPlanLower) {
    return isTrial ? "Upgrade" : "Current Plan";
  }
  if (selectedPlan === "plus") {
    return currentPlan ? "Downgrade" : "Upgrade";
  }
  if (selectedPlan === "pro") {
    return "Upgrade";
  }
  return "Contact us";
}

type ChangePlanDialogProps = {
  currentPlan?: string;
  customerType?: "organization" | "user";
  isTrial?: boolean;
  referenceId?: string;
  returnUrl?: string;
};

function ChangePlanDialog(props: ChangePlanDialogProps) {
  const [selectedPlan, setSelectedPlan] = useState("plus");
  const id = useId();
  const returnUrl = props.returnUrl || "/settings/organization/members";

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          className={cn(
            "gap-2",
            !props.currentPlan && "bg-linear-to-br from-purple-100 to-stone-300"
          )}
          size="sm"
          variant={props.currentPlan ? "outline" : "default"}
        >
          {props.currentPlan ? (
            <RefreshCcw className="opacity-80" size={14} strokeWidth={2} />
          ) : (
            <ArrowUpFromLine className="opacity-80" size={14} strokeWidth={2} />
          )}
          {props.currentPlan ? "Change Plan" : "Upgrade Plan"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <div className="mb-2 flex flex-col gap-2">
          <div
            aria-hidden="true"
            className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border"
          >
            {props.currentPlan ? (
              <RefreshCcw className="opacity-80" size={16} strokeWidth={2} />
            ) : (
              <CreditCard className="opacity-80" size={16} strokeWidth={2} />
            )}
          </div>
          <DialogHeader>
            <DialogTitle className="text-left">
              {props.currentPlan ? "Change" : "Upgrade"} your plan
            </DialogTitle>
            <DialogDescription className="text-left">
              Pick one of the following plans.
            </DialogDescription>
          </DialogHeader>
        </div>

        <form className="space-y-5">
          <RadioGroup
            className="gap-2"
            defaultValue="2"
            onValueChange={(value) => setSelectedPlan(value)}
            value={selectedPlan}
          >
            <div className="relative flex w-full items-center gap-2 rounded-lg border border-input px-4 py-3 shadow-black/5 shadow-sm has-data-[state=checked]:border-ring has-data-[state=checked]:bg-accent">
              <RadioGroupItem
                aria-describedby={`${id}-1-description`}
                className="order-1 after:absolute after:inset-0"
                id={`${id}-1`}
                value="plus"
              />
              <div className="grid grow gap-1">
                <Label htmlFor={`${id}-1`}>Plus</Label>
                <p
                  className="text-muted-foreground text-xs"
                  id={`${id}-1-description`}
                >
                  $20/month
                </p>
              </div>
            </div>
            <div className="relative flex w-full items-center gap-2 rounded-lg border border-input px-4 py-3 shadow-black/5 shadow-sm has-data-[state=checked]:border-ring has-data-[state=checked]:bg-accent">
              <RadioGroupItem
                aria-describedby={`${id}-2-description`}
                className="order-1 after:absolute after:inset-0"
                id={`${id}-2`}
                value="pro"
              />
              <div className="grid grow gap-1">
                <Label htmlFor={`${id}-2`}>Pro</Label>
                <p
                  className="text-muted-foreground text-xs"
                  id={`${id}-2-description`}
                >
                  $200/month
                </p>
              </div>
            </div>
            <div className="relative flex w-full items-center gap-2 rounded-lg border border-input px-4 py-3 shadow-black/5 shadow-sm has-data-[state=checked]:border-ring has-data-[state=checked]:bg-accent">
              <RadioGroupItem
                aria-describedby={`${id}-3-description`}
                className="order-1 after:absolute after:inset-0"
                id={`${id}-3`}
                value="enterprise"
              />
              <div className="grid grow gap-1">
                <Label htmlFor={`${id}-3`}>Enterprise</Label>
                <p
                  className="text-muted-foreground text-xs"
                  id={`${id}-3-description`}
                >
                  Contact our sales team
                </p>
              </div>
            </div>
          </RadioGroup>

          <div className="space-y-3">
            <p className="text-center text-white/70 text-xs">
              note: all upgrades takes effect immediately and you'll be charged
              the new amount on your next billing cycle.
            </p>
          </div>

          <div className="grid gap-2">
            <Button
              className="w-full"
              disabled={
                selectedPlan === props.currentPlan?.toLowerCase() &&
                !props.isTrial
              }
              onClick={async () => {
                if (selectedPlan === "enterprise") {
                  return;
                }
                await client.subscription.upgrade(
                  {
                    cancelUrl: returnUrl,
                    customerType: props.customerType,
                    plan: selectedPlan,
                    referenceId: props.referenceId,
                    returnUrl,
                    successUrl: returnUrl,
                  },
                  {
                    onError: (ctx: any) => {
                      toast.error(ctx.error.message);
                    },
                  }
                );
              }}
              type="button"
            >
              {getButtonText(selectedPlan, props.currentPlan, props.isTrial)}
            </Button>
            {props.currentPlan && (
              <Button
                className="w-full"
                onClick={async () => {
                  await client.subscription.cancel(
                    {
                      customerType: props.customerType,
                      referenceId: props.referenceId,
                      returnUrl,
                    },
                    {
                      onError: (ctx: any) => {
                        toast.error(ctx.error.message);
                      },
                    }
                  );
                }}
                type="button"
                variant="destructive"
              >
                Cancel Plan
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { ChangePlanDialog };
