import { useMemo } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { LocalizedField } from "@/components/admin/LocalizedField";
import { localizedSchema } from "@/lib/admin/schemas";
import type { listUiStrings } from "@/lib/admin/fns/ui-strings";

type UiStringRow = Awaited<ReturnType<typeof listUiStrings>>[number];

/** Friendly Chinese labels for known group_key values; unknown keys fall back to the raw key. */
const GROUP_LABELS: Record<string, string> = {
  brand: "品牌",
  nav: "導覽列",
  footer: "頁尾",
  buttons: "按鈕",
  sections: "區塊標題",
  notFound: "404 頁面",
};

function groupLabel(key: string): string {
  return GROUP_LABELS[key] ?? key;
}

/**
 * Form-local schema — deliberately NOT uiStringSchema from schemas.ts.
 * group_key/string_key identify each row and must never be editable, so they
 * are never registered as form fields at all (see handleSubmit below, which
 * re-merges them from the loader's `uiStrings` array by index rather than
 * trusting anything the form could produce). Only value/sort_order are real
 * form state.
 */
function buildStringsFormSchema() {
  return z.object({
    strings: z.array(
      z.object({
        value: localizedSchema,
        sort_order: z.number().int("排序必須是整數"),
      }),
    ),
  });
}
type StringsFormValues = z.infer<ReturnType<typeof buildStringsFormSchema>>;

export const Route = createFileRoute("/admin/_shell/strings")({
  loader: async () => {
    const { listUiStrings } = await import("@/lib/admin/fns/ui-strings");
    const uiStrings = await listUiStrings();
    return { uiStrings };
  },
  head: () => ({
    meta: [{ title: "介面文字｜小時光書店後台" }],
  }),
  component: AdminStringsPage,
});

function AdminStringsPage() {
  const stringsFormSchema = useMemo(buildStringsFormSchema, []);
  const { uiStrings } = Route.useLoaderData();
  const router = useRouter();

  // First-seen order of group_key, so tabs follow the same order as the DB
  // (ui_strings_group_idx orders by group_key, sort_order — see
  // src/server/repos/ui-strings.ts).
  const groups = useMemo(() => {
    const seen: string[] = [];
    for (const row of uiStrings) {
      if (!seen.includes(row.group_key)) seen.push(row.group_key);
    }
    return seen;
  }, [uiStrings]);

  const form = useForm<StringsFormValues>({
    resolver: zodResolver(stringsFormSchema),
    defaultValues: {
      strings: uiStrings.map((row) => ({ value: row.value, sort_order: row.sort_order })),
    },
  });

  const submitting = form.formState.isSubmitting;

  async function handleSubmit(values: StringsFormValues) {
    try {
      // Re-merge group_key/string_key from the loaded rows (by index) rather
      // than from form state — those two columns are identifiers only and
      // are never part of the form, so there is no code path here that could
      // send an edited key back to the server.
      const payload = uiStrings.map((row, index) => ({
        group_key: row.group_key,
        string_key: row.string_key,
        value: values.strings[index].value,
        sort_order: values.strings[index].sort_order,
      }));
      const { updateUiStrings } = await import("@/lib/admin/fns/ui-strings");
      await updateUiStrings({ data: payload });
      toast.success("已儲存介面文字");
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium">介面文字</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          共 {uiStrings.length} 筆。這些代號由程式碼直接讀取，只能修改內容與排序，不提供新增或刪除。
        </p>
      </div>

      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(handleSubmit, () => {
            toast.error("有欄位尚未填寫完整，請切換分頁檢查（中文／英文／日文皆為必填）");
          })}
          className="space-y-6"
        >
          <Tabs defaultValue={groups[0]}>
            <TabsList className="flex-wrap">
              {groups.map((key) => (
                <TabsTrigger key={key} value={key}>
                  {groupLabel(key)}
                </TabsTrigger>
              ))}
            </TabsList>
            {groups.map((groupKey) => (
              <TabsContent key={groupKey} value={groupKey} className="space-y-4">
                {uiStrings.map((row: UiStringRow, index) =>
                  row.group_key === groupKey ? (
                    <div
                      key={`${row.group_key}.${row.string_key}`}
                      className="space-y-3 rounded-md border border-border p-4"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <code className="text-xs text-muted-foreground">
                          {row.group_key}.{row.string_key}
                        </code>
                        <FormField
                          control={form.control}
                          name={`strings.${index}.sort_order`}
                          render={({ field }) => (
                            <FormItem className="flex items-center gap-2 space-y-0">
                              <FormLabel className="text-xs text-muted-foreground">排序</FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  className="h-8 w-20"
                                  name={field.name}
                                  ref={field.ref}
                                  onBlur={field.onBlur}
                                  value={field.value}
                                  onChange={(e) =>
                                    field.onChange(
                                      e.target.value === "" ? 0 : Number(e.target.value),
                                    )
                                  }
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                      <LocalizedField name={`strings.${index}.value`} label={row.string_key} />
                    </div>
                  ) : null,
                )}
              </TabsContent>
            ))}
          </Tabs>

          <div className="flex justify-end">
            <Button type="submit" disabled={submitting}>
              {submitting ? "儲存中…" : "儲存全部變更"}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
