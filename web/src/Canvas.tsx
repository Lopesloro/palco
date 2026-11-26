import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap, ConnectionMode, BaseEdge, getBezierPath, useReactFlow,
  SelectionMode,
  type Edge as RFEdge, type EdgeProps, type Node as RFNode, type NodeChangeset, type Connection, type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { op } from './api';
import { setState, toast, useStore } from './store';
import { nodeTypes, noteColor, type NodeDataIn } from './nodes/nodes';
import { dialog } from './ui';
import type { BandData, DrawingData, PalcoNode, Workspace } from './types';

function RopeEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  const d = (data ?? {}) as { live?: boolean; band?: boolean };
  return (
    <BaseEdge
      id={id}
      path={path}
      className={`rope ${d.live ? 'live' : ''} ${d.band ? 'band-rope' : ''} ${selected ? 'sel' : ''}`}
      interactionWidth={18}
    />
  );
}
const edgeTypes = { rope: RopeEdge };

const toRF = (n: PalcoNode, wsId: string, selected: boolean): RFNode => ({
  id: n.id,
  type: n.type,
  position: { x: n.x, y: n.y },
  data: { node: n, wsId } satisfies NodeDataIn,
  width: n.w,
  height: n.h,
  style: { width: n.w, height: n.h },
  selected,
  dragHandle: n.type === 'drawing' ? undefined : '.drag-handle',
  zIndex: n.type === 'drawing' ? 0 : n.type === 'band' ? 1 : 2,
});

export function Canvas({ ws, floorId }: { ws: Workspace; floorId: string }) {
  const rf = useReactFlow();
  const statuses = useStore((s) => s.statuses);
  const tool = useStore((s) => s.tool);
  const focus = useStore((s) => s.focusNode);
  const presets = useStore((s) => s.config?.presets);
  const [nodes, setNodes] = useState<RFNode[]>([]);
  const dragging = useRef(new Set<string>());
  const [menu, setMenu] = useState<{ x: number; y: number; fx: number; fy: number }>();

  // rebuild from server state, keeping local selection and in-flight drags
  useEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return ws.nodes.filter((n) => n.floorId === floorId).map((n) => {
        const old = byId.get(n.id);
        const next = toRF(n, ws.id, !!old?.selected);
        if (old && dragging.current.has(n.id)) next.position = old.position;
        return next;
      });
    });
  }, [ws, floorId]);

  const edges = useMemo<RFEdge[]>(() => {
    const here = new Set(ws.nodes.filter((n) => n.floorId === floorId).map((n) => n.id));
    const busy = (id: string) => statuses[id] === 'busy';
    const real = ws.edges.filter((e) => here.has(e.a) && here.has(e.b)).map((e) => ({
      id: e.id, source: e.a, target: e.b, sourceHandle: 'r', targetHandle: 'l', type: 'rope',
      data: { live: busy(e.a) || busy(e.b) },
    }));
    const bandLinks = ws.nodes.filter((n) => n.type === 'band' && n.floorId === floorId).flatMap((b) =>
      (b.data as BandData).members.filter((m) => here.has(m)).map((m) => ({
        id: `band:${b.id}:${m}`, source: b.id, target: m, sourceHandle: 'r', targetHandle: 'l', type: 'rope',
        selectable: false, deletable: false, data: { band: true, live: busy(m) },
      })));
    return [...real, ...bandLinks];
  }, [ws, floorId, statuses]);

  // restore and remember the viewport per floor
  const restored = useRef('');
  useEffect(() => {
    const key = `${ws.id}:${floorId}`;
    if (restored.current === key) return;
    restored.current = key;
    const vp = ws.viewport[floorId];
    requestAnimationFrame(() => {
      if (vp) void rf.setViewport(vp);
      else if (ws.nodes.some((n) => n.floorId === floorId)) void rf.fitView({ padding: 0.15, maxZoom: 1 });
      else void rf.setViewport({ x: 80, y: 60, zoom: 0.9 });
    });
  }, [ws.id, floorId]);
  const vpTimer = useRef<number>(undefined);
  const onMoveEnd = (_: unknown, vp: Viewport) => {
    window.clearTimeout(vpTimer.current);
    vpTimer.current = window.setTimeout(() => op('ws.viewport', { wsId: ws.id, floorId, viewport: vp }), 600);
  };

  useEffect(() => {
    if (!focus) return;
    const n = ws.nodes.find((x) => x.id === focus.id);
    if (!n) return;
    if (n.floorId !== floorId) setState((s) => ({ currentFloor: { ...s.currentFloor, [ws.id]: n.floorId } }));
    setTimeout(() => void rf.fitView({ nodes: [{ id: n.id }], duration: 400, maxZoom: 1, padding: 0.3 }), 60);
  }, [focus?.at]);

  const onNodesChange = useCallback((changes: NodeChangeset<RFNode>) => {
    setNodes((ns) => changes.applyTo(ns));
    // remember drags in flight so a server broadcast mid-drag does not snap nodes back;
    // the final position is saved once, in onNodeDragStop
    for (const c of changes) if (c.type === 'position' && c.dragging) dragging.current.add(c.id);
  }, []);

  const onNodeDragStop = useCallback((_: unknown, __: RFNode, dragged: RFNode[]) => {
    const items = dragged.map((n) => ({ nodeId: n.id, patch: { x: Math.round(n.position.x), y: Math.round(n.position.y) } }));
    dragged.forEach((n) => dragging.current.delete(n.id));
    void op('node.updateMany', { wsId: ws.id, items });
  }, [ws.id]);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    op('edge.add', { wsId: ws.id, a: c.source, b: c.target }).catch((e) => toast((e as Error).message, 'Corda'));
  }, [ws.id]);

  const onBeforeDelete = useCallback(async ({ nodes: ns, edges: es }: { nodes: RFNode[]; edges: RFEdge[] }) => {
    const terms = ns.filter((n) => n.type === 'terminal');
    if (terms.length) {
      const ok = await dialog(`Remover ${terms.length} terminal(is)? O processo é encerrado.`, [], { submit: 'Remover', danger: true });
      if (!ok) return false;
    }
    if (ns.length) await op('node.remove', { wsId: ws.id, nodeId: ns.map((n) => n.id) });
    for (const e of es) if (!e.id.startsWith('band:')) await op('edge.remove', { edgeId: e.id });
    return false; // the server broadcast removes them
  }, [ws.id]);

  const addAt = async (type: PalcoNode['type'], fx: number, fy: number, extra: Record<string, unknown> = {}) => {
    try {
      if (type === 'portal') {
        const r = await dialog('Novo portal', [{ key: 'url', label: 'Endereço', placeholder: 'localhost:3000 ou https://…' }, { key: 'name', label: 'Nome', value: 'Portal' }]);
        if (!r) return;
        extra = { data: { name: r.name || 'Portal', url: r.url } };
      }
      const n = await op<PalcoNode>('node.add', { wsId: ws.id, type, floorId, x: Math.round(fx), y: Math.round(fy), ...extra });
      setState({ focusNode: { id: n.id, at: Date.now() } });
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const onPaneContext = (e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setMenu({ x: e.clientX, y: e.clientY, fx: p.x, fy: p.y });
  };

  // ------------------------------------------------------------ drawing
  const [stroke, setStroke] = useState<[number, number][]>([]);
  const drawing = tool !== 'select';
  const pointer = (e: React.PointerEvent) => {
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    return [p.x, p.y] as [number, number];
  };
  const finishStroke = async () => {
    const pts = stroke;
    setStroke([]);
    if (pts.length < 2) return;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const w = Math.max(10, Math.max(...xs) - minX), h = Math.max(10, Math.max(...ys) - minY);
    const simplified = pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1).map(([x, y]) => [Math.round(x - minX), Math.round(y - minY)] as [number, number]);
    const data: DrawingData = { kind: tool as DrawingData['kind'], points: simplified, color: '#e8a33d', width: 3 };
    await op('node.add', { wsId: ws.id, type: 'drawing', floorId, x: Math.round(minX), y: Math.round(minY), w: Math.round(w), h: Math.round(h), data });
  };
  const screenStroke = stroke.map(([x, y]) => {
    const vp = rf.getViewport();
    return [x * vp.zoom + vp.x, y * vp.zoom + vp.y];
  });

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setState({ tool: 'select' });
  };

  const quick = (presets ?? []).filter((p) => p.quickStart);

  return (
    <div className="canvas" onKeyDown={onKey} onClick={() => setMenu(undefined)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onBeforeDelete={onBeforeDelete}
        onMoveEnd={onMoveEnd}
        onPaneContextMenu={onPaneContext}
        onSelectionChange={({ nodes: sel }) => setState({ selection: sel.map((n) => n.id) })}
        connectionMode={ConnectionMode.Loose}
        selectionMode={SelectionMode.Partial}
        selectionOnDrag={false}
        panActivationKeyCode={null}
        zoomActivationKeyCode={null}
        multiSelectionKeyCode={['Shift', 'Meta']}
        deleteKeyCode={['Backspace', 'Delete']}
        minZoom={0.1}
        maxZoom={2.5}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'rope' }}
        connectionLineStyle={{ stroke: '#e8a33d', strokeWidth: 2.5 }}
        onlyRenderVisibleElements={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="#2c313b" />
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap pannable zoomable position="bottom-left" nodeColor={(n) => {
          const pn = (n.data as NodeDataIn).node;
          if (pn.type === 'note') return noteColor((pn.data as { color: string }).color);
          if (pn.type === 'terminal') return statuses[pn.id] === 'busy' ? '#e8a33d' : '#4f5868';
          return '#3a4150';
        }} maskColor="rgba(10,12,16,0.7)" />
      </ReactFlow>

      {drawing && (
        <div
          className="draw-layer"
          onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); setStroke([pointer(e)]); }}
          onPointerMove={(e) => {
            if (!stroke.length) return;
            const p = pointer(e);
            setStroke((s) => (tool === 'pen' ? [...s, p] : [s[0], p]));
          }}
          onPointerUp={() => void finishStroke()}
        >
          <svg width="100%" height="100%">
            {screenStroke.length > 1 && (tool === 'rect'
              ? <rect x={Math.min(screenStroke[0][0], screenStroke[1][0])} y={Math.min(screenStroke[0][1], screenStroke[1][1])} width={Math.abs(screenStroke[1][0] - screenStroke[0][0])} height={Math.abs(screenStroke[1][1] - screenStroke[0][1])} rx={8} fill="none" stroke="#e8a33d" strokeWidth={3} />
              : <polyline points={screenStroke.map((p) => p.join(',')).join(' ')} fill="none" stroke="#e8a33d" strokeWidth={3} strokeLinecap="round" />)}
          </svg>
          <div className="draw-hint">Desenhando ({tool === 'pen' ? 'caneta' : tool === 'arrow' ? 'seta' : 'retângulo'}) — Esc para sair</div>
        </div>
      )}

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <div className="ctx-title">Adicionar aqui</div>
          {quick.map((p) => (
            <button key={p.id} onClick={() => { setMenu(undefined); void addAt('terminal', menu.fx, menu.fy, { presetId: p.id }); }}>
              <span className="swatch" style={{ background: p.color }} /> {p.name}
            </button>
          ))}
          <hr />
          <button onClick={() => { setMenu(undefined); void addAt('note', menu.fx, menu.fy); }}>📝 Nota</button>
          <button onClick={() => { setMenu(undefined); void addAt('portal', menu.fx, menu.fy); }}>🌐 Portal (navegador)</button>
        </div>
      )}

      {ws.nodes.filter((n) => n.floorId === floorId).length === 0 && (
        <div className="empty-canvas">
          <h2>Palco vazio</h2>
          <p>Clique com o botão direito no canvas para adicionar um agente, nota ou portal — ou use os botões no topo.</p>
          <p className="muted">Arraste de uma bolinha lateral até outro card para criar uma corda: agentes conectados conversam pela CLI <code>palco</code>.</p>
        </div>
      )}
    </div>
  );
}
