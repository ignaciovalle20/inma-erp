"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type AllocateWorkState = {
  error: string | null;
  success: boolean;
  values: {
    project_id: string;
    amount: string;
    hours: string;
  };
};

export async function allocateWork(
  companyId: string,
  personnelId: string,
  personnelCostId: string,
  _prevState: AllocateWorkState,
  formData: FormData,
): Promise<AllocateWorkState> {
  const projectId = formData.get("project_id");
  const amount = formData.get("amount");
  const hours = formData.get("hours");

  const values = {
    project_id: typeof projectId === "string" ? projectId : "",
    amount: typeof amount === "string" ? amount : "",
    hours: typeof hours === "string" ? hours : "",
  };

  if (typeof projectId !== "string" || !projectId.trim()) {
    return { error: "Please select a project.", success: false, values };
  }

  const parsedAmount = typeof amount === "string" ? Number(amount) : NaN;

  if (
    typeof amount !== "string" ||
    !amount.trim() ||
    !Number.isFinite(parsedAmount) ||
    parsedAmount <= 0
  ) {
    return {
      error: "Amount must be a number greater than zero.",
      success: false,
      values,
    };
  }

  let parsedHours: number | null = null;

  if (typeof hours === "string" && hours.trim() !== "") {
    const candidate = Number(hours);
    if (!Number.isFinite(candidate) || candidate < 0) {
      return {
        error: "Hours must be a non-negative number.",
        success: false,
        values,
      };
    }
    parsedHours = candidate;
  }

  const supabase = await createClient();

  // App-level guard confirming the personnel cost belongs to this
  // person/company -- the DB trigger is the real cross-company
  // guarantee for project_id, this just avoids a confusing raw error
  // and confirms the cost record exists before calling the RPC.
  const { data: existing, error: existingError } = await supabase
    .from("personnel_costs")
    .select("id")
    .eq("id", personnelCostId)
    .eq("personnel_id", personnelId)
    .maybeSingle();

  if (existingError) {
    console.error(existingError);
    return {
      error: "Something went wrong. Please try again.",
      success: false,
      values,
    };
  }

  if (!existing) {
    return {
      error: "You don't have permission to allocate this cost record.",
      success: false,
      values,
    };
  }

  const { error } = await supabase.rpc("allocate_work", {
    p_personnel_cost_id: personnelCostId,
    p_project_id: projectId,
    p_amount: parsedAmount,
    p_hours: parsedHours,
  });

  if (error) {
    console.error(error);
    return {
      error: error.message ?? "Something went wrong. Please try again.",
      success: false,
      values,
    };
  }

  revalidatePath(
    `/companies/${companyId}/personnel/${personnelId}/costs/${personnelCostId}/allocate`,
  );

  return {
    error: null,
    success: true,
    values: { project_id: "", amount: "", hours: "" },
  };
}

export type RemoveWorkAllocationState = {
  error: string | null;
};

export async function removeWorkAllocation(
  companyId: string,
  personnelId: string,
  personnelCostId: string,
  allocationId: string,
): Promise<RemoveWorkAllocationState> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("work_allocations")
    .delete()
    .eq("id", allocationId)
    .eq("personnel_cost_id", personnelCostId);

  if (error) {
    console.error(error);
    return { error: "Something went wrong. Please try again." };
  }

  revalidatePath(
    `/companies/${companyId}/personnel/${personnelId}/costs/${personnelCostId}/allocate`,
  );

  return { error: null };
}
