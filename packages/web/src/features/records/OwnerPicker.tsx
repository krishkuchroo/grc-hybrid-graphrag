// The owner picker: the org's members from GET /api/v1/people (S1-004). It is never hidden or
// locked by role (D206): whoever may edit a record may change its owner, and the API decides.
import type * as React from 'react';
import { NativeSelect } from '@/components/ui/native-select';
import { usePeople } from './useRecords';

type Props = Omit<React.ComponentProps<'select'>, 'children' | 'value' | 'onChange'> & {
  value: string;
  onValueChange: (value: string) => void;
  /** The empty choice's text. */
  emptyText?: string;
  /** Keep the empty choice even once someone is picked (a filter's "any owner"). */
  allowEmpty?: boolean;
};

export function OwnerPicker({
  value,
  onValueChange,
  emptyText = 'Choose an owner',
  allowEmpty = false,
  ...props
}: Props) {
  const people = usePeople();
  const list = people.data ?? [];
  const known = list.some((p) => p.id === value);
  return (
    <NativeSelect {...props} value={known ? value : ''} onChange={(e) => onValueChange(e.target.value)}>
      {allowEmpty || !known ? <option value="">{emptyText}</option> : null}
      {list.map((person) => (
        <option key={person.id} value={person.id}>
          {person.name}
        </option>
      ))}
    </NativeSelect>
  );
}
