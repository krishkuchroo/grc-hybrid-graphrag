// Shared set-up for the S1-012 tests: "Remove" on each related-records row (D201, D207).
//
// The API is mocked at the client boundary with S1-008's fake (`tests/record-links/helpers.tsx`),
// which also follows S1-011's `POST /api/v1/links/remove`: 400 for a bad body, 404 `not_found` when
// an end is missing or hidden or there is no such link, 403 `forbidden` when `canLinkRecords`
// fails, 409 `ai_link_review_only` when the link's origin is `ai`, else 200 and the link is gone.
//
// Contract with the app (S1-012 brief):
// - Each related-records row the person may remove shows a button whose name starts with "Remove"
//   (for example "Remove" or "Remove link to CTL0001001"). Other rows show no such button.
// - "Remove" opens a confirmation (a dialog or alertdialog) naming the group title, the other
//   record's number and name, and saying the removal is recorded in the audit trail. It has a
//   "Cancel" button and a confirm button ("Remove", "Remove link", "Confirm" or "Yes, remove").
import { screen, waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import { findGroup, rowFor, type StoredRecord, type User } from '../record-links/helpers';

export * from '../record-links/helpers';

/** The "Remove" button in the row for `other` in `group`, or null. */
export function removeButtonIn(group: HTMLElement, other: StoredRecord): HTMLElement | null {
  const row = rowFor(group, other.number);
  expect(row, `a row for ${other.number}`).toBeTruthy();
  return within(row!).queryByRole('button', { name: /^remove\b/i });
}

/** Every "Remove" button on the page. */
export function allRemoveButtons(): HTMLElement[] {
  return screen.queryAllByRole('button', { name: /^remove\b/i });
}

/** The open confirmation. */
export function findConfirmation(): Promise<HTMLElement> {
  return waitFor(() => screen.queryByRole('alertdialog') ?? screen.getByRole('dialog'));
}

export function queryConfirmation(): HTMLElement | null {
  return screen.queryByRole('alertdialog') ?? screen.queryByRole('dialog');
}

/** Clicks "Remove" on the row for `other` in the group titled `title` and returns the confirmation. */
export async function openRemove(user: User, title: RegExp, other: StoredRecord): Promise<HTMLElement> {
  const group = await findGroup(title);
  const button = await waitFor(() => {
    const b = removeButtonIn(group, other);
    expect(b, `a "Remove" button on ${other.number}`).not.toBeNull();
    return b!;
  });
  await user.click(button);
  return findConfirmation();
}

export function confirmButton(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('button', { name: /^(remove|remove link|confirm|yes, remove)$/i });
}

export function cancelButton(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('button', { name: /^cancel$/i });
}

/** Everything written on the page, the open dialog included. */
export function pageText(): string {
  return document.body.textContent ?? '';
}
