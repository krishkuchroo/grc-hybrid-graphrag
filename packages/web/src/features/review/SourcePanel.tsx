// Where a finding came from (S5-005): the uploaded document (its name, kind, uploader, when and
// label) and the sentence the extraction read, highlighted inside its passage (the chunk's text, at
// the place S5-002 found it). The passage is the document's own words, so it is set apart from the
// interface in a reading face. A document or passage the reader may not read is left out by the
// API (D51); the panel says so instead of guessing. At its foot, what the upload put in, and for the
// Analyst the way to remove all of it (S5-006, ./RemoveUpload).
import { Link } from '@tanstack/react-router';
import { FileText, ListFilter, Quote } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { KIND_TEXT } from '@/features/intake/permissions';
import { formatMoment } from '@/features/records/format';
import { LabelBadge } from '@/features/records/LabelBadge';
import { UploadImpactSection } from './RemoveUpload';
import { Panel, Sheet } from './ReviewBits';
import type { FindingDetail, ReviewSearch } from './useReview';
import { HIDDEN_DOCUMENT_TEXT, textOrNull } from './words';

type Uploader = NonNullable<FindingDetail['document']>['uploader'];

function uploaderText(uploader: Uploader): string {
  if (uploader.type === 'api_key') return textOrNull(uploader.name) ?? 'An API key';
  if (uploader.type === 'system') return 'The system (sample data)';
  return textOrNull(uploader.name) ?? 'A former member';
}

/** The chunk's text with the sentence marked, scrolled so the mark shows. */
function Passage({ text, at }: { text: string; at: { start: number; end: number } | null }) {
  const box = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLElement>(null);
  const place =
    at && at.start >= 0 && at.end <= text.length && at.end > at.start ? { start: at.start, end: at.end } : null;

  useLayoutEffect(() => {
    const container = box.current;
    const marked = mark.current;
    if (!container || !marked) return;
    // The box is positioned, so the mark's offset is measured from the box's own top.
    container.scrollTop = Math.max(0, marked.offsetTop - container.clientHeight / 3);
  }, [place?.start, place?.end]);

  return (
    <div
      ref={box}
      tabIndex={0}
      aria-label="The passage the sentence was read from"
      className="focus-visible:ring-ring/50 relative max-h-80 overflow-y-auto rounded-md border border-[#e4dfd2] bg-[#fbfaf6] px-5 py-4 font-serif text-[15px] leading-[1.75] whitespace-pre-wrap text-[#2a2f33] outline-none focus-visible:ring-[3px]"
    >
      {place ? (
        <>
          <span className="text-[#5d6469]">{text.slice(0, place.start)}</span>
          <mark
            ref={mark}
            className="rounded-[2px] bg-[#fbe4a0] box-decoration-clone px-0.5 text-[#1d2327] shadow-[inset_0_-2px_0_#e0b54a]"
          >
            {text.slice(place.start, place.end)}
          </mark>
          <span className="text-[#5d6469]">{text.slice(place.end)}</span>
        </>
      ) : (
        text
      )}
    </div>
  );
}

function SentenceQuote({ sentence }: { sentence: string }) {
  return (
    <blockquote className="border-l-[3px] border-[#e0b54a] bg-[#fdf6e0] py-2 pr-3 pl-4 font-serif text-[15px] leading-relaxed text-[#1d2327]">
      {sentence}
    </blockquote>
  );
}

export function SourcePanel({
  finding,
  canRemoveUpload,
}: {
  finding: FindingDetail;
  /** The Analyst (Review-queue `work`): offers "Remove everything from this upload". */
  canRemoveUpload: boolean;
}) {
  const document = finding.document;
  const sentence = textOrNull(finding.sentence);
  const chunk = finding.chunk;
  const fromDocument: ReviewSearch = { documentId: document?.id };
  if (finding.kind !== 'link') fromDocument.kind = finding.kind;

  return (
    <Panel
      title="Source"
      icon={FileText}
      toolbar={
        document ? (
          <Link
            to="/review"
            search={fromDocument}
            className="text-primary inline-flex items-center gap-1 text-xs font-semibold hover:underline"
          >
            <ListFilter className="size-3.5" aria-hidden />
            All findings from this upload
          </Link>
        ) : null
      }
    >
      {document ? (
        <Sheet
          items={[
            {
              label: 'Document',
              value: (
                <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-semibold [overflow-wrap:anywhere]">{document.name}</span>
                  <span className="text-muted-foreground text-xs">{KIND_TEXT[document.kind]}</span>
                  <LabelBadge label={document.label} />
                </span>
              ),
              wide: true,
            },
            { label: 'Uploaded by', value: uploaderText(document.uploader) },
            { label: 'Uploaded', value: formatMoment(document.uploadedAt) },
          ]}
        />
      ) : (
        <p className="text-muted-foreground px-5 py-4 text-sm">
          {HIDDEN_DOCUMENT_TEXT}. It’s above your clearance or of a kind your role can’t view, so its details and text
          are left out.
        </p>
      )}

      {chunk || sentence ? (
        <div className="grid gap-3 border-t px-5 py-4">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold">
            <Quote className="text-muted-foreground size-3.5" aria-hidden />
            {chunk ? 'The sentence in its passage' : 'The sentence'}
          </h3>
          {chunk && chunk.sentenceAt ? (
            <Passage text={chunk.text} at={chunk.sentenceAt} />
          ) : (
            <>
              {sentence ? <SentenceQuote sentence={sentence} /> : null}
              {chunk ? (
                <>
                  <p className="text-muted-foreground text-xs">
                    The sentence wasn’t found word for word in its passage, which is shown below as it was read.
                  </p>
                  <Passage text={chunk.text} at={null} />
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {document ? <UploadImpactSection documentId={document.id} canRemove={canRemoveUpload} /> : null}
    </Panel>
  );
}
