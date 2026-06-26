/**
 * designHistory.ts — Phase 3 Command Undo/Redo pattern.
 */

import type { DesignDocument, DesignCommand } from '../types/designDocument';
import { isDesignInstance, isDesignEntity } from '../types/designDocument';

/**
 * Applies a command to a DesignDocument and returns the updated document
 * along with its exact inverse command for undo/redo stacks.
 */
export function applyDesignCommand(
  doc: DesignDocument,
  cmd: DesignCommand,
): { doc: DesignDocument; inverse: DesignCommand } {
  const nextNodes = [...doc.nodes];

  switch (cmd.type) {
    case 'AddNode': {
      nextNodes.push(cmd.node);
      return {
        doc: { ...doc, nodes: nextNodes, revision: doc.revision + 1 },
        inverse: { type: 'DeleteNode', nodeId: cmd.node.id, snapshot: cmd.node },
      };
    }

    case 'DeleteNode': {
      const idx = nextNodes.findIndex(n => n.id === cmd.nodeId);
      if (idx === -1) {
        return { doc, inverse: cmd };
      }
      const snapshot = nextNodes[idx];
      nextNodes.splice(idx, 1);
      return {
        doc: { ...doc, nodes: nextNodes, revision: doc.revision + 1 },
        inverse: { type: 'AddNode', node: snapshot },
      };
    }

    case 'UpdateInstanceTransform': {
      const idx = nextNodes.findIndex(n => n.id === cmd.nodeId);
      if (idx === -1) return { doc, inverse: cmd };
      const node = nextNodes[idx];
      if (!isDesignInstance(node)) return { doc, inverse: cmd };

      const updatedNode = {
        ...node,
        transform: { ...cmd.after },
      };
      nextNodes[idx] = updatedNode;
      return {
        doc: { ...doc, nodes: nextNodes, revision: doc.revision + 1 },
        inverse: {
          type: 'UpdateInstanceTransform',
          nodeId: cmd.nodeId,
          before: cmd.after,
          after: cmd.before,
        },
      };
    }

    case 'UpdateEntityVertices': {
      const idx = nextNodes.findIndex(n => n.id === cmd.nodeId);
      if (idx === -1) return { doc, inverse: cmd };
      const node = nextNodes[idx];
      if (!isDesignEntity(node)) return { doc, inverse: cmd };

      const updatedNode = {
        ...node,
        vertices: [...cmd.after],
      };
      nextNodes[idx] = updatedNode;
      return {
        doc: { ...doc, nodes: nextNodes, revision: doc.revision + 1 },
        inverse: {
          type: 'UpdateEntityVertices',
          nodeId: cmd.nodeId,
          before: cmd.after,
          after: cmd.before,
        },
      };
    }

    case 'UpdateFrame': {
      return {
        doc: { ...doc, frame: { ...cmd.after }, revision: doc.revision + 1 },
        inverse: {
          type: 'UpdateFrame',
          before: cmd.after,
          after: cmd.before,
        },
      };
    }

    case 'UpdateNodeGroupId': {
      const idx = nextNodes.findIndex(n => n.id === cmd.nodeId);
      if (idx === -1) return { doc, inverse: cmd };
      const node = nextNodes[idx];
      const updatedNode = {
        ...node,
        metadata: {
          ...node.metadata,
          groupId: cmd.after,
        },
      };
      nextNodes[idx] = updatedNode;
      return {
        doc: { ...doc, nodes: nextNodes, revision: doc.revision + 1 },
        inverse: {
          type: 'UpdateNodeGroupId',
          nodeId: cmd.nodeId,
          before: cmd.after,
          after: cmd.before,
        },
      };
    }

    case 'Batch': {
      const inverseCmds: DesignCommand[] = [];
      let currentDoc = doc;
      for (const subCmd of cmd.commands) {
        const res = applyDesignCommand(currentDoc, subCmd);
        currentDoc = res.doc;
        inverseCmds.unshift(res.inverse);
      }
      return {
        doc: currentDoc,
        inverse: { type: 'Batch', commands: inverseCmds },
      };
    }
  }
}
