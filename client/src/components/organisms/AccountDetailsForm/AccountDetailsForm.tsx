import type { FC } from 'react';
import { useState } from 'react';
import { Alert, App, Button, Checkbox, Form, Input } from 'antd';
import {
  ABOUT_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  LOGIN_MAX_LENGTH,
  LOGIN_MIN_LENGTH,
  NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
} from 'shared';
import type { UpdateUserPayload } from 'shared';
import { loginForbiddenCharacterRule } from '@/constants/loginRule';
import { maxLengthRule } from '@/constants/maxLengthRule';
import { useUpdateAccount } from '@/queries/users';
import { accountFieldErrors } from '@/types/accountErrors';
import type { PublicUser } from '@/types/api';
import spacing from '@/theme/spacing.module.css';

const FIELDS = [
  'login',
  'email',
  'firstName',
  'lastName',
  'about',
  'showLastSeen',
] as const;

type AccountValues = Pick<PublicUser, (typeof FIELDS)[number]> & {
  currentPassword?: string;
};

const pickFields = (user: PublicUser): AccountValues => ({
  login: user.login,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  about: user.about,
  showLastSeen: user.showLastSeen,
});

export const AccountDetailsForm: FC<{ user: PublicUser }> = ({ user }) => {
  const [form] = Form.useForm<AccountValues>();
  const { message } = App.useApp();
  const updateAccount = useUpdateAccount(user.id);
  const [formError, setFormError] = useState<string | null>(null);
  // The baseline every diff compares against: the last saved values, which
  // lead the session refetch.
  const [saved, setSaved] = useState(() => pickFields(user));
  const values = Form.useWatch([], form);

  // Each entry pairs a field with its own value type, so one cast stands in
  // for what a loop assigning over the key union cannot express.
  const changes = Object.fromEntries(
    FIELDS.flatMap((name) => {
      const value = values?.[name];
      return value !== undefined && value !== saved[name]
        ? [[name, value]]
        : [];
    })
  ) as UpdateUserPayload;
  const hasChanges = Object.keys(changes).length > 0;
  const emailChanged = 'email' in changes;

  const handleFinish = async (formValues: AccountValues) => {
    setFormError(null);

    try {
      const result = await updateAccount.mutateAsync(
        emailChanged
          ? { ...changes, currentPassword: formValues.currentPassword }
          : changes
      );
      void message.success('Account updated.');
      setSaved(pickFields(result));
      form.setFieldsValue({ ...pickFields(result), currentPassword: '' });
    } catch (error) {
      const fieldErrors = accountFieldErrors<AccountValues>(error);
      if (fieldErrors) {
        form.setFields(fieldErrors);
        return;
      }
      setFormError(
        error instanceof Error ? error.message : 'Could not save the account'
      );
    }
  };

  return (
    <>
      {formError !== null && (
        <Alert type="error" title={formError} className={spacing.gapBelow} />
      )}

      {/* void: handleFinish reports its own failure in the form. */}
      <Form
        name="account"
        form={form}
        layout="vertical"
        initialValues={pickFields(user)}
        onFinish={(formValues) => void handleFinish(formValues)}
      >
        <Form.Item
          name="login"
          label="Login"
          rules={[
            { required: true, message: 'Enter a login' },
            {
              min: LOGIN_MIN_LENGTH,
              max: LOGIN_MAX_LENGTH,
              message: `Login must be ${LOGIN_MIN_LENGTH} to ${LOGIN_MAX_LENGTH} characters`,
            },
            loginForbiddenCharacterRule,
          ]}
        >
          <Input autoComplete="username" />
        </Form.Item>

        {/* `required` alone lets "   " through; the server trims, then requires one character. */}
        <Form.Item
          name="firstName"
          label="First name"
          rules={[
            {
              required: true,
              whitespace: true,
              message: 'Enter your first name',
            },
            maxLengthRule('First name', NAME_MAX_LENGTH),
          ]}
        >
          <Input autoComplete="given-name" />
        </Form.Item>

        <Form.Item
          name="lastName"
          label="Last name"
          rules={[
            {
              required: true,
              whitespace: true,
              message: 'Enter your last name',
            },
            maxLengthRule('Last name', NAME_MAX_LENGTH),
          ]}
        >
          <Input autoComplete="family-name" />
        </Form.Item>

        <Form.Item
          name="email"
          label="Email"
          rules={[
            { required: true, message: 'Enter an email address' },
            { type: 'email', message: 'Enter a valid email address' },
            maxLengthRule('Email', EMAIL_MAX_LENGTH),
          ]}
        >
          <Input autoComplete="email" />
        </Form.Item>

        <Form.Item
          name="about"
          label="About"
          rules={[maxLengthRule('About', ABOUT_MAX_LENGTH)]}
        >
          <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} />
        </Form.Item>

        <Form.Item name="showLastSeen" valuePropName="checked">
          <Checkbox>Show when I was last online</Checkbox>
        </Form.Item>

        {emailChanged && (
          <Form.Item
            name="currentPassword"
            preserve={false}
            label="Current password"
            rules={[
              { required: true, message: 'Enter your current password' },
              { max: PASSWORD_MAX_LENGTH },
            ]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>
        )}

        <Button
          type="primary"
          htmlType="submit"
          disabled={!hasChanges}
          loading={updateAccount.isPending}
        >
          Save
        </Button>
      </Form>
    </>
  );
};
