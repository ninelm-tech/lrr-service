import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdatePlatformConfigDto } from './dto/update-platform-config.dto';
import { normalizePhone } from '../common/phone.util';

// Both alert lists fan out a synchronous WhatsApp send per number on a hot
// path (every dispute/low-rating/stalled-confirmation, or every single new
// request) — this caps the blast radius of an admin accidentally pasting a
// large list (e.g. the wrong clipboard contents) into either field.
const MAX_ALERT_PHONE_NUMBERS = 10;

export interface PlatformConfigValues {
  serviceFeePercent: number;
  depositPercent: number;
  dispatchWindowMinutes: number;
  dispatchBatchSize: number;
  /** Phase 2: how long quote collection runs from the FIRST quote. */
  quoteCollectionMinutes: number;
  disputeAlertPhoneNumbers: string[];
  /** Customers routed to isTest operators only — see findAndRankCandidates. */
  testCustomerPhoneNumbers: string[];
  /** Alerted whenever a request becomes dispatch-ready — see handleMediaFinished. */
  newRequestAlertPhoneNumbers: string[];
}

@Injectable()
export class PlatformConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async getConfig(): Promise<PlatformConfigValues> {
    const row = await this.prisma.platformConfig.findFirst();
    return {
      serviceFeePercent: row!.serviceFeePercent.toNumber(),
      depositPercent: row!.depositPercent.toNumber(),
      dispatchWindowMinutes: row!.dispatchWindowMinutes,
      dispatchBatchSize: row!.dispatchBatchSize,
      quoteCollectionMinutes: row!.quoteCollectionMinutes,
      disputeAlertPhoneNumbers: row!.disputeAlertPhoneNumbers,
      testCustomerPhoneNumbers: row!.testCustomerPhoneNumbers,
      newRequestAlertPhoneNumbers: row!.newRequestAlertPhoneNumbers,
    };
  }

  async updateConfig(
    dto: UpdatePlatformConfigDto,
  ): Promise<PlatformConfigValues> {
    if (
      dto.serviceFeePercent !== undefined &&
      (dto.serviceFeePercent < 0 || dto.serviceFeePercent > 100)
    ) {
      throw new BadRequestException(
        'serviceFeePercent must be between 0 and 100',
      );
    }
    // Capped at 50, not 100 — this is also the floor an operator's own
    // depositPercentOverride can't go below (see
    // OperatorService.setDepositPercent/adminCreate), which read this value
    // live. A platform default above 50 would make the floor exceed the
    // operator-override ceiling, making every override attempt impossible.
    if (
      dto.depositPercent !== undefined &&
      (dto.depositPercent < 0 || dto.depositPercent > 50)
    ) {
      throw new BadRequestException('depositPercent must be between 0 and 50');
    }
    if (
      dto.dispatchWindowMinutes !== undefined &&
      (dto.dispatchWindowMinutes < 1 || dto.dispatchWindowMinutes > 60)
    ) {
      throw new BadRequestException(
        'dispatchWindowMinutes must be between 1 and 60',
      );
    }
    if (
      dto.dispatchBatchSize !== undefined &&
      (dto.dispatchBatchSize < 1 || dto.dispatchBatchSize > 20)
    ) {
      throw new BadRequestException(
        'dispatchBatchSize must be between 1 and 20',
      );
    }
    if (
      dto.quoteCollectionMinutes !== undefined &&
      (dto.quoteCollectionMinutes < 1 || dto.quoteCollectionMinutes > 60)
    ) {
      throw new BadRequestException(
        'quoteCollectionMinutes must be between 1 and 60',
      );
    }

    let normalizedTestNumbers: string[] | undefined;
    if (dto.testCustomerPhoneNumbers !== undefined) {
      try {
        normalizedTestNumbers =
          dto.testCustomerPhoneNumbers.map(normalizePhone);
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : 'Invalid phone number',
        );
      }
    }

    if (
      dto.disputeAlertPhoneNumbers !== undefined &&
      dto.disputeAlertPhoneNumbers.length > MAX_ALERT_PHONE_NUMBERS
    ) {
      throw new BadRequestException(
        `disputeAlertPhoneNumbers cannot have more than ${MAX_ALERT_PHONE_NUMBERS} numbers`,
      );
    }
    let normalizedDisputeAlertNumbers: string[] | undefined;
    if (dto.disputeAlertPhoneNumbers !== undefined) {
      try {
        normalizedDisputeAlertNumbers =
          dto.disputeAlertPhoneNumbers.map(normalizePhone);
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : 'Invalid phone number',
        );
      }
    }

    if (
      dto.newRequestAlertPhoneNumbers !== undefined &&
      dto.newRequestAlertPhoneNumbers.length > MAX_ALERT_PHONE_NUMBERS
    ) {
      throw new BadRequestException(
        `newRequestAlertPhoneNumbers cannot have more than ${MAX_ALERT_PHONE_NUMBERS} numbers`,
      );
    }
    let normalizedNewRequestAlertNumbers: string[] | undefined;
    if (dto.newRequestAlertPhoneNumbers !== undefined) {
      try {
        normalizedNewRequestAlertNumbers =
          dto.newRequestAlertPhoneNumbers.map(normalizePhone);
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : 'Invalid phone number',
        );
      }
    }

    const existing = await this.prisma.platformConfig.findFirst();

    const data: Record<string, number | string | string[]> = {};
    if (dto.serviceFeePercent !== undefined)
      data.serviceFeePercent = dto.serviceFeePercent;
    if (dto.depositPercent !== undefined)
      data.depositPercent = dto.depositPercent;
    if (dto.dispatchWindowMinutes !== undefined)
      data.dispatchWindowMinutes = dto.dispatchWindowMinutes;
    if (dto.dispatchBatchSize !== undefined)
      data.dispatchBatchSize = dto.dispatchBatchSize;
    if (dto.quoteCollectionMinutes !== undefined)
      data.quoteCollectionMinutes = dto.quoteCollectionMinutes;
    if (normalizedTestNumbers !== undefined)
      data.testCustomerPhoneNumbers = normalizedTestNumbers;
    if (normalizedDisputeAlertNumbers !== undefined)
      data.disputeAlertPhoneNumbers = normalizedDisputeAlertNumbers;
    if (normalizedNewRequestAlertNumbers !== undefined)
      data.newRequestAlertPhoneNumbers = normalizedNewRequestAlertNumbers;

    const updated = await this.prisma.platformConfig.update({
      where: { id: existing!.id },
      data,
    });

    return {
      serviceFeePercent: updated.serviceFeePercent.toNumber(),
      depositPercent: updated.depositPercent.toNumber(),
      dispatchWindowMinutes: updated.dispatchWindowMinutes,
      dispatchBatchSize: updated.dispatchBatchSize,
      quoteCollectionMinutes: updated.quoteCollectionMinutes,
      disputeAlertPhoneNumbers: updated.disputeAlertPhoneNumbers,
      testCustomerPhoneNumbers: updated.testCustomerPhoneNumbers,
      newRequestAlertPhoneNumbers: updated.newRequestAlertPhoneNumbers,
    };
  }
}
