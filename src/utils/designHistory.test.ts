import { describe, it, expect } from 'vitest';
import { applyDesignCommand } from './designHistory';
import {
  createDesignDocument,
  createDesignInstance,
  createDesignVertex,
} from '../types/designDocument';

describe('designHistory', () => {
  it('correctly applies and inverts AddNode and DeleteNode commands', () => {
    const doc = createDesignDocument('test-doc');
    const node = createDesignInstance('inst-1', 'tpl-1', {
      northM: 1,
      eastM: 2,
      rotationDeg: 0,
      scale: 1,
    });

    // 1. Add node
    const { doc: doc2, inverse: inv1 } = applyDesignCommand(doc, {
      type: 'AddNode',
      node,
    });
    expect(doc2.nodes).toHaveLength(1);
    expect(doc2.nodes[0].id).toBe('inst-1');
    expect(doc2.revision).toBe(1);

    // 2. Undo (apply inverse of AddNode -> DeleteNode)
    const { doc: doc3 } = applyDesignCommand(doc2, inv1);
    expect(doc3.nodes).toHaveLength(0);
    expect(doc3.revision).toBe(2);
  });

  it('correctly applies and inverts UpdateInstanceTransform', () => {
    const doc = createDesignDocument('test-doc');
    const node = createDesignInstance('inst-1', 'tpl-1', {
      northM: 1,
      eastM: 2,
      rotationDeg: 0,
      scale: 1,
    });
    doc.nodes.push(node);

    const transformAfter = { northM: 5, eastM: 10, rotationDeg: 45, scale: 2 };

    const { doc: doc2, inverse: inv } = applyDesignCommand(doc, {
      type: 'UpdateInstanceTransform',
      nodeId: 'inst-1',
      before: node.transform,
      after: transformAfter,
    });

    const instNode = doc2.nodes[0] as any;
    expect(instNode.transform.northM).toBe(5);
    expect(instNode.transform.scale).toBe(2);

    // Undo transform
    const { doc: doc3 } = applyDesignCommand(doc2, inv);
    const instNodeUndo = doc3.nodes[0] as any;
    expect(instNodeUndo.transform.northM).toBe(1);
    expect(instNodeUndo.transform.scale).toBe(1);
  });

  it('handles Batch commands in correct topological order', () => {
    const doc = createDesignDocument('test-doc');
    const n1 = createDesignInstance('inst-1', 't-1', { northM: 0, eastM: 0, rotationDeg: 0, scale: 1 });
    const n2 = createDesignInstance('inst-2', 't-1', { northM: 0, eastM: 0, rotationDeg: 0, scale: 1 });

    const batch = {
      type: 'Batch' as const,
      commands: [
        { type: 'AddNode' as const, node: n1 },
        { type: 'AddNode' as const, node: n2 },
      ],
    };

    const { doc: doc2, inverse } = applyDesignCommand(doc, batch);
    expect(doc2.nodes).toHaveLength(2);
    expect(doc2.nodes[0].id).toBe('inst-1');
    expect(doc2.nodes[1].id).toBe('inst-2');

    // Undo Batch (which deletes in reverse order)
    const { doc: doc3 } = applyDesignCommand(doc2, inverse);
    expect(doc3.nodes).toHaveLength(0);
  });
});
