'use client';

import { Input, MoneyInput, MoneyText, OtpInput, Stepper, Switch } from '@repo/ui';
import { useState } from 'react';
import { GalleryGroup, GallerySection } from './GallerySection';
import { sampleMoney, type GalleryLang } from './samples';
import type { Sample } from './samples-uz';

export function InputsSection({ lang, s }: { lang: GalleryLang; s: Sample }) {
  const [username, setUsername] = useState('dilnoza_k');
  const [promoDraft, setPromoDraft] = useState('');
  const [promo, setPromo] = useState('GG2025');
  const [verified, setVerified] = useState('dilnoza_k');
  const [playerId, setPlayerId] = useState('5123');
  const [zone, setZone] = useState('');
  const [amount, setAmount] = useState('150000');
  const [qty, setQty] = useState('500');
  const [code, setCode] = useState('');
  const [wrong, setWrong] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [lastCode, setLastCode] = useState('');
  const [reduce, setReduce] = useState(false);
  const [dense, setDense] = useState(true);

  const qtyNumber = Number(qty);
  const qtyError = qty !== '' && (qtyNumber < 50 || qtyNumber > 1000) ? s.qtyOutOfRange : undefined;
  const unit = sampleMoney('0', lang).unit;
  const rate = sampleMoney('22000', lang);

  return (
    <GallerySection
      id="inputs"
      title="Inputs"
      note="48 high, label above, help or error below (error replaces help)"
    >
      <GalleryGroup label="Input · help / error / success / disabled">
        <div className="flex flex-col gap-4">
          <Input
            label={s.promoLabel}
            value={promoDraft}
            onValueChange={setPromoDraft}
            help={s.promoHelp}
            placeholder="GG2026"
          />
          <Input label={s.promoLabel} value={promo} onValueChange={setPromo} error={s.promoError} />
          <Input
            label={s.usernameLabel}
            value={verified}
            onValueChange={setVerified}
            kind="username"
            success={s.usernameOk}
          />
          <Input
            label={s.promoLabel}
            value={s.promoDisabled}
            onValueChange={() => undefined}
            disabled
          />
        </div>
      </GalleryGroup>

      <GalleryGroup label="Username · Player ID (digits)">
        <div className="flex flex-col gap-4">
          <Input
            label={s.usernameLabel}
            kind="username"
            value={username}
            onValueChange={setUsername}
            help={s.usernameHelp}
            placeholder="username"
          />
          <div className="grid grid-cols-[minmax(0,1fr)_108px] gap-2.5">
            <Input
              label={s.playerId}
              kind="digits"
              value={playerId}
              onValueChange={setPlayerId}
              placeholder="512345678"
            />
            <Input
              label={s.zoneId}
              labelNote={s.optional}
              kind="digits"
              value={zone}
              onValueChange={setZone}
              placeholder="1234"
            />
          </div>
        </div>
      </GalleryGroup>

      <GalleryGroup label="MoneyInput · live grouping, quick chips, min / max">
        <MoneyInput
          label={s.amountLabel}
          value={amount}
          onValueChange={setAmount}
          unit={unit}
          help={s.amountHelp}
          min="1000"
          max="5000000"
          minError={s.amountMin}
          maxError={s.amountMax}
          quickAmounts={[
            { value: '50000', label: '+50 000' },
            { value: '100000', label: '+100 000' },
            { value: '200000', label: '+200 000' },
          ]}
        />
      </GalleryGroup>

      <GalleryGroup label="Stepper · min 50 / max 1000 · out of range shows an error">
        <div className="flex flex-col gap-3">
          <Stepper
            label={s.qtyLabel}
            value={qty}
            onValueChange={setQty}
            min={50}
            max={1000}
            step={50}
            decrementLabel={s.decrement}
            incrementLabel={s.increment}
            adornment="⭐"
            help={s.qtyHelp}
            error={qtyError}
          />
          <div className="flex items-baseline justify-between border-t border-dashed border-border pt-2.5">
            <span className="text-[13px] leading-[18px] font-medium text-foreground-muted">
              1 ⭐ ≈
            </span>
            <MoneyText size="lg" {...rate} />
          </div>
        </div>
      </GalleryGroup>

      <GalleryGroup label="OtpInput · paste, auto-submit, error shake" wide>
        <div className="flex max-w-[420px] flex-col gap-3">
          <OtpInput
            value={code}
            onChange={(next) => {
              setCode(next);
              setWrong(false);
            }}
            onComplete={(complete) => {
              setLastCode(complete);
              const bad = complete !== '482913';
              setWrong(bad);
              if (bad) setAttempts((count) => count + 1);
            }}
            error={wrong}
            errorKey={attempts}
            errorMessage={s.otpWrong}
            label={s.otpGroup}
            boxLabel={s.otpBox}
          />
          <p
            className="text-center text-xs font-medium text-foreground-muted"
            data-testid="otp-last"
          >
            {lastCode ? `onComplete: ${lastCode}` : '482913 = correct'}
          </p>
        </div>
      </GalleryGroup>

      <GalleryGroup label="Switch · md (profile) / sm (admin dense)">
        <div className="flex flex-col gap-3">
          <label className="flex items-center justify-between gap-3 text-sm font-bold">
            {s.reduceMotion}
            <Switch checked={reduce} onCheckedChange={setReduce} label={s.reduceMotion} />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm font-bold">
            {s.reduceMotion}
            <Switch
              size="sm"
              checked={dense}
              onCheckedChange={setDense}
              label={`${s.reduceMotion} (sm)`}
            />
          </label>
        </div>
      </GalleryGroup>
    </GallerySection>
  );
}
