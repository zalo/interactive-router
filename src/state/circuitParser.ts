import type { ComponentData, PadData, ConnectionData, ConnectionEndpoint, BoardData } from "../types"

interface RawElement {
  type: string
  [key: string]: any
}

export interface ParsedCircuit {
  board: BoardData
  components: Map<string, ComponentData>
  connections: ConnectionData[]
}

export function parseCircuitJson(elements: RawElement[]): ParsedCircuit {
  // Index elements by type and ID
  const byType = new Map<string, RawElement[]>()
  const byId = new Map<string, RawElement>()

  for (const el of elements) {
    const arr = byType.get(el.type) || []
    arr.push(el)
    byType.set(el.type, arr)

    // Index by primary ID
    const idKey = Object.keys(el).find((k) => k.endsWith("_id") && k !== "source_component_id" && k !== "pcb_component_id" && k !== "pcb_port_id" && k !== "source_port_id" && k === `${el.type}_id`)
    if (idKey) {
      byId.set(el[idKey], el)
    }
  }

  // Parse board
  const boardEls = byType.get("pcb_board") || []
  const boardEl = boardEls[0]
  const board: BoardData = {
    width: boardEl?.width || 55,
    height: boardEl?.height || 60,
    layerCount: boardEl?.num_layers || 2,
  }

  // Parse components
  const components = new Map<string, ComponentData>()
  const pcbComponents = byType.get("pcb_component") || []
  const sourceComponents = byType.get("source_component") || []
  const pcbSmtpads = byType.get("pcb_smtpad") || []
  const pcbPorts = byType.get("pcb_port") || []
  const sourcePorts = byType.get("source_port") || []

  // Build lookup maps
  const sourceCompById = new Map<string, RawElement>()
  for (const sc of sourceComponents) {
    sourceCompById.set(sc.source_component_id, sc)
  }

  const portsByCompId = new Map<string, RawElement[]>()
  for (const pp of pcbPorts) {
    const arr = portsByCompId.get(pp.pcb_component_id) || []
    arr.push(pp)
    portsByCompId.set(pp.pcb_component_id, arr)
  }

  const padsByCompId = new Map<string, RawElement[]>()
  for (const pad of pcbSmtpads) {
    const arr = padsByCompId.get(pad.pcb_component_id) || []
    arr.push(pad)
    padsByCompId.set(pad.pcb_component_id, arr)
  }

  const sourcePortById = new Map<string, RawElement>()
  for (const sp of sourcePorts) {
    sourcePortById.set(sp.source_port_id, sp)
  }

  const pcbPortBySourcePortId = new Map<string, RawElement>()
  for (const pp of pcbPorts) {
    pcbPortBySourcePortId.set(pp.source_port_id, pp)
  }

  const pcbPortById = new Map<string, RawElement>()
  for (const pp of pcbPorts) {
    pcbPortById.set(pp.pcb_port_id, pp)
  }

  for (const pcbComp of pcbComponents) {
    const sourceComp = sourceCompById.get(pcbComp.source_component_id)
    const compPads = padsByCompId.get(pcbComp.pcb_component_id) || []
    const compPorts = portsByCompId.get(pcbComp.pcb_component_id) || []
    const cx = pcbComp.center?.x ?? 0
    const cy = pcbComp.center?.y ?? 0
    const rot = pcbComp.rotation ?? 0
    const rotRad = (-rot * Math.PI) / 180

    const pads: PadData[] = compPads.map((pad) => {
      // Compute local coordinates by unrotating the world-space pad position
      const dx = pad.x - cx
      const dy = pad.y - cy
      const localX = dx * Math.cos(rotRad) - dy * Math.sin(rotRad)
      const localY = dx * Math.sin(rotRad) + dy * Math.cos(rotRad)

      // Find the source port for this pad
      const pcbPort = compPorts.find((p) => p.pcb_port_id === pad.pcb_port_id)
      const sourcePort = pcbPort ? sourcePortById.get(pcbPort.source_port_id) : undefined

      return {
        id: pad.pcb_smtpad_id,
        localX,
        localY,
        width: pad.width || 0.5,
        height: pad.height || 0.5,
        layer: pad.layer || "top",
        layers: pcbPort?.layers || [pad.layer || "top"],
        portId: pcbPort?.source_port_id,
        netIds: [],
      }
    })

    let compType: ComponentData["componentType"] = "other"
    const ftype = sourceComp?.ftype || ""
    if (ftype.includes("capacitor") || sourceComp?.name?.startsWith("C")) compType = "capacitor"
    else if (ftype.includes("resistor") || sourceComp?.name?.startsWith("R")) compType = "resistor"
    else if (ftype.includes("pinheader") || sourceComp?.name?.startsWith("J2")) compType = "pinheader"
    else if (ftype.includes("chip") || sourceComp?.name?.startsWith("U") || sourceComp?.name?.startsWith("J") || sourceComp?.name?.startsWith("K")) compType = "chip"

    components.set(pcbComp.pcb_component_id, {
      id: pcbComp.pcb_component_id,
      name: sourceComp?.name || pcbComp.pcb_component_id,
      width: pcbComp.width || 2,
      height: pcbComp.height || 2,
      pads,
      sourceComponentId: pcbComp.source_component_id,
      originalPcbX: cx,
      originalPcbY: cy,
      originalRotation: rot,
      componentType: compType,
    })
  }

  // Parse connections from source_traces and source_nets
  const sourceTraces = byType.get("source_trace") || []
  const sourceNets = byType.get("source_net") || []

  // Build net membership: which source_port_ids belong to which net
  const netById = new Map<string, RawElement>()
  for (const net of sourceNets) {
    netById.set(net.source_net_id, net)
  }

  // Resolve source_port_id → { componentId (pcb), padId, layer }
  function resolveEndpoint(sourcePortId: string): ConnectionEndpoint | null {
    const pcbPort = pcbPortBySourcePortId.get(sourcePortId)
    if (!pcbPort) return null

    const compId = pcbPort.pcb_component_id
    const comp = components.get(compId)
    if (!comp) return null

    // Find pad by pcb_port_id
    const pad = comp.pads.find((p) => {
      // Match via pcb_port association
      const padEl = pcbSmtpads.find((s) => s.pcb_smtpad_id === p.id)
      return padEl?.pcb_port_id === pcbPort.pcb_port_id
    })
    if (!pad) return null

    return {
      componentId: compId,
      padId: pad.id,
      layer: pad.layer,
    }
  }

  const connections: ConnectionData[] = []
  let connIdCounter = 0

  // Group traces by net - traces connected to the same net are part of the same connection group
  const netConnections = new Map<string, ConnectionEndpoint[]>()

  for (const trace of sourceTraces) {
    const portIds: string[] = trace.connected_source_port_ids || []
    const netIds: string[] = trace.connected_source_net_ids || []

    const endpoints: ConnectionEndpoint[] = []
    for (const pid of portIds) {
      const ep = resolveEndpoint(pid)
      if (ep) endpoints.push(ep)
    }

    if (netIds.length > 0) {
      // This trace connects ports to a net
      for (const netId of netIds) {
        const arr = netConnections.get(netId) || []
        arr.push(...endpoints)
        netConnections.set(netId, arr)
      }
    } else if (endpoints.length >= 2) {
      // Direct port-to-port connection (no net)
      connections.push({
        id: `conn_${++connIdCounter}`,
        name: `trace_${connIdCounter}`,
        endpoints,
      })
    }
  }

  // Create connections for each net
  for (const [netId, endpoints] of netConnections) {
    if (endpoints.length < 2) continue
    const net = netById.get(netId)
    const netName = net?.name || netId

    // Deduplicate endpoints (same component+pad)
    const seen = new Set<string>()
    const uniqueEndpoints = endpoints.filter((ep) => {
      const key = `${ep.componentId}:${ep.padId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    if (uniqueEndpoints.length >= 2) {
      connections.push({
        id: `conn_net_${++connIdCounter}`,
        name: netName,
        endpoints: uniqueEndpoints,
      })
    }
  }

  return { board, components, connections }
}
