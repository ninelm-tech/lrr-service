import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { RescueRequestController } from './rescue-request.controller';
import { DisputeService } from './dispute.service';
import { RescueRequestAdminService } from './rescue-request-admin.service';
import { DispatchService } from './dispatch.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { WhatsAppOperatorFlowService } from './whatsapp-operator-flow.service';

const req = { user: { userId: 'admin-1' } } as never;

describe('RescueRequestController — manual dispatch actions', () => {
  let controller: RescueRequestController;
  let rescueRequestAdminService: {
    findRawForManualAction: jest.Mock;
    claimManualArrived: jest.Mock;
    assignOperator: jest.Mock;
    manualCandidatesFor: jest.Mock;
  };
  let operatorFlowService: {
    notifyCustomerOperatorArrived: jest.Mock;
    startManualCompletionConfirmation: jest.Mock;
  };
  let auditLogService: { record: jest.Mock };

  beforeEach(async () => {
    rescueRequestAdminService = {
      findRawForManualAction: jest.fn(),
      claimManualArrived: jest.fn(),
      assignOperator: jest.fn(),
      manualCandidatesFor: jest.fn(),
    };
    operatorFlowService = {
      notifyCustomerOperatorArrived: jest.fn(),
      startManualCompletionConfirmation: jest.fn(),
    };
    auditLogService = { record: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RescueRequestController],
      providers: [
        { provide: DisputeService, useValue: {} },
        {
          provide: RescueRequestAdminService,
          useValue: rescueRequestAdminService,
        },
        { provide: DispatchService, useValue: {} },
        { provide: AuditLogService, useValue: auditLogService },
        {
          provide: WhatsAppOperatorFlowService,
          useValue: operatorFlowService,
        },
        { provide: JwtService, useValue: {} },
      ],
    }).compile();

    controller = module.get(RescueRequestController);
  });

  describe('manualArrived', () => {
    it('manualArrived rejects a WhatsApp-enabled operator override with no reason given', async () => {
      rescueRequestAdminService.findRawForManualAction.mockResolvedValue({
        status: 'OPERATOR_ASSIGNED',
        assignedOperator: { whatsappEnabled: true },
      });

      await expect(controller.manualArrived(req, 'req-1', {})).rejects.toThrow(
        'reason',
      );
      expect(
        rescueRequestAdminService.claimManualArrived,
      ).not.toHaveBeenCalled();
      expect(
        operatorFlowService.notifyCustomerOperatorArrived,
      ).not.toHaveBeenCalled();
    });

    it('manualArrived accepts a WhatsApp-enabled operator override when a reason is given, and resets their WhatsApp session', async () => {
      rescueRequestAdminService.findRawForManualAction.mockResolvedValue({
        status: 'OPERATOR_ASSIGNED',
        assignedOperatorId: 'op-1',
        assignedOperator: { whatsappEnabled: true },
      });
      rescueRequestAdminService.claimManualArrived.mockResolvedValue({
        claimed: true,
      });

      await controller.manualArrived(req, 'req-1', {
        reason: 'WhatsApp unreachable, operator called support',
      });

      // The session reset itself lives inside claimManualArrived (Task 9) —
      // the controller's job is only to require and forward the reason.
      expect(rescueRequestAdminService.claimManualArrived).toHaveBeenCalledWith(
        'req-1',
        { reason: 'WhatsApp unreachable, operator called support' },
      );
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'manual_operator_arrived',
          actorId: 'admin-1',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- a nested expect.objectContaining(...) value loses its generic inference when assigned to an outer objectContaining's property; same @types/jest looseness as the expect.not case elsewhere in this codebase
          details: expect.objectContaining({
            reason: 'WhatsApp unreachable, operator called support',
          }),
        }),
      );
    });

    it('rejects a request not in OPERATOR_ASSIGNED, without attempting a claim', async () => {
      rescueRequestAdminService.findRawForManualAction.mockResolvedValue({
        status: 'WAITING_FOR_DEPOSIT',
        assignedOperator: { whatsappEnabled: false },
      });

      await expect(controller.manualArrived(req, 'req-1', {})).rejects.toThrow(
        'WAITING_FOR_DEPOSIT',
      );
      expect(
        rescueRequestAdminService.claimManualArrived,
      ).not.toHaveBeenCalled();
    });

    it('claims, notifies, and audit-logs for an eligible request — no reason required for a non-WhatsApp operator', async () => {
      rescueRequestAdminService.findRawForManualAction.mockResolvedValue({
        status: 'OPERATOR_ASSIGNED',
        assignedOperatorId: 'op-1',
        assignedOperator: { whatsappEnabled: false },
      });
      rescueRequestAdminService.claimManualArrived.mockResolvedValue({
        claimed: true,
      });

      await controller.manualArrived(req, 'req-1', {});

      expect(rescueRequestAdminService.claimManualArrived).toHaveBeenCalledWith(
        'req-1',
        { reason: undefined },
      );
      expect(
        operatorFlowService.notifyCustomerOperatorArrived,
      ).toHaveBeenCalledWith('req-1');
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'manual_operator_arrived',
          actorId: 'admin-1',
        }),
      );
    });

    it('rejects and does not notify when the atomic claim loses the race — pre-check passed but status changed before the claim ran', async () => {
      rescueRequestAdminService.findRawForManualAction.mockResolvedValue({
        status: 'OPERATOR_ASSIGNED',
        assignedOperatorId: 'op-1',
        assignedOperator: { whatsappEnabled: false },
      });
      rescueRequestAdminService.claimManualArrived.mockResolvedValue({
        claimed: false,
      });

      await expect(controller.manualArrived(req, 'req-1', {})).rejects.toThrow(
        /no longer eligible|already/i,
      );
      expect(
        operatorFlowService.notifyCustomerOperatorArrived,
      ).not.toHaveBeenCalled();
      expect(auditLogService.record).not.toHaveBeenCalled();
    });
  });

  describe('manualDone', () => {
    it('rejects a WhatsApp-enabled operator override with no reason given', async () => {
      rescueRequestAdminService.findRawForManualAction.mockResolvedValue({
        status: 'ARRIVED',
        assignedOperator: { whatsappEnabled: true },
      });

      await expect(controller.manualDone(req, 'req-1', {})).rejects.toThrow(
        'reason',
      );
      expect(
        operatorFlowService.startManualCompletionConfirmation,
      ).not.toHaveBeenCalled();
    });

    it('accepts a WhatsApp-enabled operator override when a reason is given', async () => {
      rescueRequestAdminService.findRawForManualAction.mockResolvedValue({
        status: 'ARRIVED',
        assignedOperatorId: 'op-1',
        assignedOperator: { whatsappEnabled: true },
      });
      operatorFlowService.startManualCompletionConfirmation.mockResolvedValue({
        claimed: true,
      });

      await controller.manualDone(req, 'req-1', {
        reason: 'WhatsApp unreachable, operator called support',
      });

      expect(
        operatorFlowService.startManualCompletionConfirmation,
      ).toHaveBeenCalledWith('req-1', {
        reason: 'WhatsApp unreachable, operator called support',
      });
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'manual_operator_done',
          actorId: 'admin-1',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- a nested expect.objectContaining(...) value loses its generic inference when assigned to an outer objectContaining's property; same @types/jest looseness as the expect.not case elsewhere in this codebase
          details: expect.objectContaining({
            reason: 'WhatsApp unreachable, operator called support',
          }),
        }),
      );
    });

    it('rejects a request not in ARRIVED, without attempting confirmation', async () => {
      rescueRequestAdminService.findRawForManualAction.mockResolvedValue({
        status: 'OPERATOR_ASSIGNED',
        assignedOperator: { whatsappEnabled: false },
      });

      await expect(controller.manualDone(req, 'req-1', {})).rejects.toThrow(
        'OPERATOR_ASSIGNED',
      );
      expect(
        operatorFlowService.startManualCompletionConfirmation,
      ).not.toHaveBeenCalled();
    });

    it('starts completion confirmation and audit-logs when the atomic claim succeeds — no reason required for a non-WhatsApp operator', async () => {
      rescueRequestAdminService.findRawForManualAction.mockResolvedValue({
        status: 'ARRIVED',
        assignedOperatorId: 'op-1',
        assignedOperator: { whatsappEnabled: false },
      });
      operatorFlowService.startManualCompletionConfirmation.mockResolvedValue({
        claimed: true,
      });

      await controller.manualDone(req, 'req-1', {});

      expect(
        operatorFlowService.startManualCompletionConfirmation,
      ).toHaveBeenCalledWith('req-1', { reason: undefined });
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'manual_operator_done',
          actorId: 'admin-1',
        }),
      );
    });

    it('rejects and does not audit-log when the atomic claim loses the race — pre-check passed but ARRIVED changed before the claim ran', async () => {
      rescueRequestAdminService.findRawForManualAction.mockResolvedValue({
        status: 'ARRIVED',
        assignedOperatorId: 'op-1',
        assignedOperator: { whatsappEnabled: false },
      });
      operatorFlowService.startManualCompletionConfirmation.mockResolvedValue({
        claimed: false,
      });

      await expect(controller.manualDone(req, 'req-1', {})).rejects.toThrow(
        /no longer eligible|already/i,
      );
      expect(auditLogService.record).not.toHaveBeenCalled();
    });
  });

  describe('assignOperator', () => {
    it('audit-logs a manual assignment to a non-WhatsApp operator with its id and business name', async () => {
      rescueRequestAdminService.assignOperator.mockResolvedValue({
        data: {
          assignedOperator: {
            id: 'op-1',
            businessName: 'Backup Towing',
            whatsappEnabled: false,
          },
        },
      });

      await controller.assignOperator(req, 'req-1', {
        operatorId: 'op-1',
        priceKobo: 500000,
      });

      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'manual_assignment_confirmed',
          actorId: 'admin-1',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- a nested expect.objectContaining(...) value loses its generic inference when assigned to an outer objectContaining's property; same @types/jest looseness as the expect.not case elsewhere in this codebase
          details: expect.objectContaining({
            operatorId: 'op-1',
            businessName: 'Backup Towing',
          }),
        }),
      );
    });

    it('does not add the manual-assignment audit category for a normal WhatsApp operator', async () => {
      rescueRequestAdminService.assignOperator.mockResolvedValue({
        data: {
          assignedOperator: {
            id: 'op-2',
            businessName: 'Normal Towing',
            whatsappEnabled: true,
          },
        },
      });

      await controller.assignOperator(req, 'req-1', {
        operatorId: 'op-2',
        priceKobo: 500000,
      });

      expect(auditLogService.record).not.toHaveBeenCalled();
    });
  });

  describe('manualCandidates', () => {
    it('delegates straight to manualCandidatesFor and returns its result', async () => {
      const candidates = { data: [{ id: 'op-1', businessName: 'Backup' }] };
      rescueRequestAdminService.manualCandidatesFor.mockResolvedValue(
        candidates,
      );

      const result = await controller.manualCandidates('req-1');

      expect(
        rescueRequestAdminService.manualCandidatesFor,
      ).toHaveBeenCalledWith('req-1');
      expect(result).toEqual(candidates);
    });
  });
});
