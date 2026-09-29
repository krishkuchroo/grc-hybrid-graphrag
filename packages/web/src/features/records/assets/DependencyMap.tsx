// The asset dependency map (screen 5, D27; S1-009): what hosts and runs what around one asset,
// drawn with React Flow (D33). The API walks HOSTS and RUNS both ways to the chosen depth and
// leaves out anything the person can't see (D51, D204); this panel draws exactly what it sends.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Background,
  BaseEdge,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getStraightPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { MAP_DEFAULT_DEPTH, MAP_MAX_DEPTH, MAP_MAX_NODES } from '@grc/shared';
import { Info, Network } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { api, type GetAssetsIdMapResponse } from '@/api/client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { cn } from '@/lib/utils';
import { ApiProblem } from '../ApiProblem';
import { words } from '../format';
import { ValueBadge } from '../ValueBadge';
import { MAP_NODE_HEIGHT, MAP_NODE_WIDTH, layoutMap, type MapPosition } from './map-layout';

type AssetMap = GetAssetsIdMapResponse;
type MapAsset = AssetMap['nodes'][number];

const DEPTHS = Array.from({ length: MAP_MAX_DEPTH }, (_, i) => i + 1);

/** The map around one asset at one depth, from GET /api/v1/assets/:id/map. */
function useAssetMap(id: string, depth: number) {
  return useQuery({
    queryKey: ['asset-map', id, depth] as const,
    queryFn: () => api.getAssetsIdMap({ id }, { depth: String(depth) }),
    // While another depth loads, the same asset's map stays up; another asset starts afresh.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === id ? previous : undefined),
  });
}

// ---- Nodes ---------------------------------------------------------------------------------------

type AssetNodeData = { asset: MapAsset; centre: boolean };
type AssetNode = Node<AssetNodeData, 'asset'>;

/** Each map card opens its asset's page; the centre is marked as the asset being viewed. */
function AssetNodeCard({ data }: NodeProps<AssetNode>) {
  const { asset, centre } = data;
  return (
    <>
      {/* React Flow joins edges to handles; the edges here run centre to centre, so the handles hide. */}
      <Handle type="target" position={Position.Top} isConnectable={false} className="!invisible" />
      <Link
        to="/assets/$id"
        params={{ id: asset.id }}
        className={cn(
          'nodrag nopan group flex h-full w-full flex-col justify-between overflow-hidden rounded-md border bg-white px-3 py-2 text-left shadow-xs transition-colors',
          'hover:border-primary focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]',
          centre ? 'border-primary border-2 bg-[#f1f8f8]' : 'border-[#c3ced2]',
        )}
      >
        <span className="flex items-center justify-between gap-2 text-xs">
          <span className={cn('font-semibold tabular-nums', centre ? 'text-primary' : 'text-[#0e5c63]')}>
            {asset.number}
          </span>
          <span title={`${words(asset.criticality)} criticality`}>
            <ValueBadge value={asset.criticality} className="text-muted-foreground text-[11px]" />
          </span>
        </span>
        <span className="text-foreground truncate text-sm font-semibold group-hover:underline" title={asset.name}>
          {asset.name}
        </span>
        <span className="text-muted-foreground flex items-center justify-between text-xs">
          <span>{words(asset.assetType)}</span>
          {centre ? <span className="text-primary font-semibold">This asset</span> : null}
        </span>
      </Link>
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="!invisible" />
    </>
  );
}

// ---- Edges ---------------------------------------------------------------------------------------

type LinkEdgeData = { from: MapPosition; to: MapPosition };
type LinkEdge = Edge<LinkEdgeData, 'link'>;

/** Where the line from one box centre to another leaves the first box. */
function boxExit(centre: MapPosition, dx: number, dy: number): MapPosition {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax === 0 && ay === 0) return centre;
  const t = Math.min(ax === 0 ? Infinity : MAP_NODE_WIDTH / 2 / ax, ay === 0 ? Infinity : MAP_NODE_HEIGHT / 2 / ay);
  return { x: centre.x + dx * t, y: centre.y + dy * t };
}

/** A straight line between the two cards' edges, labelled with the link type and arrowed at its end. */
function LinkLine({ id, data, label, markerEnd, style }: EdgeProps<LinkEdge>) {
  const from = { x: data!.from.x + MAP_NODE_WIDTH / 2, y: data!.from.y + MAP_NODE_HEIGHT / 2 };
  const to = { x: data!.to.x + MAP_NODE_WIDTH / 2, y: data!.to.y + MAP_NODE_HEIGHT / 2 };
  const start = boxExit(from, to.x - from.x, to.y - from.y);
  const end = boxExit(to, from.x - to.x, from.y - to.y);
  const [path, labelX, labelY] = getStraightPath({
    sourceX: start.x,
    sourceY: start.y,
    targetX: end.x,
    targetY: end.y,
  });
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={style}
      label={label}
      labelX={labelX}
      labelY={labelY}
      labelStyle={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', fill: '#35505c' }}
      labelBgStyle={{ fill: '#f2f4f5' }}
      labelBgPadding={[4, 2]}
      labelBgBorderRadius={3}
    />
  );
}

const NODE_TYPES = { asset: AssetNodeCard };
const EDGE_TYPES = { link: LinkLine };
const EDGE_COLOUR: Record<string, string> = { HOSTS: '#5b7f8c', RUNS: '#1b8a94' };

function toFlow(centreId: string, map: AssetMap): { nodes: AssetNode[]; edges: LinkEdge[] } {
  const positions = layoutMap(centreId, map.nodes, map.edges);
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const nodes: AssetNode[] = map.nodes.map((asset) => ({
    id: asset.id,
    type: 'asset',
    position: positions[asset.id]!,
    data: { asset, centre: asset.id === centreId },
    width: MAP_NODE_WIDTH,
    height: MAP_NODE_HEIGHT,
    style: { width: MAP_NODE_WIDTH, height: MAP_NODE_HEIGHT },
    ariaLabel: `${asset.number} ${asset.name}, ${words(asset.assetType)}, ${words(asset.criticality)} criticality`,
  }));
  const edges: LinkEdge[] = map.edges
    .filter((e) => byId.has(e.fromId) && byId.has(e.toId))
    .map((e) => {
      const colour = EDGE_COLOUR[e.type] ?? '#5b7f8c';
      return {
        id: `${e.fromId}-${e.type}-${e.toId}`,
        type: 'link',
        source: e.fromId,
        target: e.toId,
        label: e.type,
        data: { from: positions[e.fromId]!, to: positions[e.toId]! },
        markerEnd: { type: MarkerType.ArrowClosed, color: colour, width: 18, height: 18 },
        style: { stroke: colour, strokeWidth: 1.5, strokeDasharray: e.type === 'RUNS' ? '5 3' : undefined },
        ariaLabel: `${byId.get(e.fromId)!.number} ${e.type} ${byId.get(e.toId)!.number}`,
      };
    });
  return { nodes, edges };
}

function Canvas({ centreId, map }: { centreId: string; map: AssetMap }) {
  const { nodes, edges } = useMemo(() => toFlow(centreId, map), [centreId, map]);
  return (
    <div className="h-[30rem] w-full bg-[#f7f9fa]" style={{ height: '30rem' }}>
      <ReactFlow
        key={`${centreId}:${nodes.length}:${edges.length}`}
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.05}
        maxZoom={1.5}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#c9d3d7" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}

// ---- The panel -----------------------------------------------------------------------------------

function Legend() {
  return (
    <div className="text-muted-foreground flex items-center gap-4 text-xs" aria-hidden>
      <span className="flex items-center gap-1.5">
        <svg width="26" height="8" viewBox="0 0 26 8">
          <line x1="0" y1="4" x2="20" y2="4" stroke={EDGE_COLOUR['HOSTS']} strokeWidth="1.5" />
          <path d="M20 0 L26 4 L20 8 Z" fill={EDGE_COLOUR['HOSTS']} />
        </svg>
        Hosts
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="26" height="8" viewBox="0 0 26 8">
          <line x1="0" y1="4" x2="20" y2="4" stroke={EDGE_COLOUR['RUNS']} strokeWidth="1.5" strokeDasharray="5 3" />
          <path d="M20 0 L26 4 L20 8 Z" fill={EDGE_COLOUR['RUNS']} />
        </svg>
        Runs
      </span>
    </div>
  );
}

function Message({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span className="bg-muted text-muted-foreground grid size-10 place-items-center rounded-full">{icon}</span>
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-muted-foreground max-w-md text-sm">{children}</p>
    </div>
  );
}

/** The "Dependency map" section of an asset's page. */
export function DependencyMap({ assetId }: { assetId: string }) {
  const [depth, setDepth] = useState(MAP_DEFAULT_DEPTH);
  const query = useAssetMap(assetId, depth);
  const pickerId = useId();
  const map = query.data;

  let body: ReactNode;
  if (query.isError) {
    body = (
      <div className="p-5">
        <ApiProblem error={query.error} title="The dependency map couldn’t be loaded" />
      </div>
    );
  } else if (!map) {
    body = (
      <div className="text-muted-foreground flex items-center gap-3 px-5 py-12 text-sm" role="status">
        <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-hidden />
        <span>Drawing the map…</span>
      </div>
    );
  } else if (map.edges.length === 0) {
    body = (
      <Message icon={<Network className="size-5" aria-hidden />} title="No dependencies yet">
        This asset doesn&apos;t host or run anything, and nothing hosts or runs it. Links added between assets show up
        here.
      </Message>
    );
  } else {
    body = (
      <>
        {map.truncated ? (
          <div className="border-b px-5 py-3">
            <Alert variant="info" role="status">
              <Info aria-hidden />
              <AlertDescription>
                <p>
                  This map was cut short at {MAP_MAX_NODES} assets. Pick a smaller depth, or open a nearer asset to see
                  the rest of its neighbourhood.
                </p>
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
        <Canvas centreId={assetId} map={map} />
      </>
    );
  }

  return (
    <section aria-label="Dependency map" className="bg-card overflow-hidden rounded-lg border shadow-xs">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-5 py-2.5">
        <h2 className="text-sm font-semibold">Dependency map</h2>
        <Legend />
        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor={pickerId} className="text-muted-foreground text-xs font-semibold">
            Depth
          </Label>
          <NativeSelect
            id={pickerId}
            className="w-28"
            value={String(depth)}
            onChange={(e) => setDepth(Number(e.target.value))}
          >
            {DEPTHS.map((d) => (
              <option key={d} value={d}>
                {d} {d === 1 ? 'step' : 'steps'}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {body}
    </section>
  );
}
