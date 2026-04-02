import { redirect as nextRedirect } from "next/navigation";

export function redirect(
  ...arguments_: Parameters<typeof nextRedirect>
): ReturnType<typeof nextRedirect> {
  return nextRedirect(...arguments_);
}
