import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Contact, ContactDocument } from '../common/schemas/contact.schema';

@Injectable()
export class ContactService {
  constructor(@InjectModel(Contact.name) private contactModel: Model<ContactDocument>) {}

  async create(contactData: Partial<Contact>): Promise<Contact> {
    const contact = new this.contactModel(contactData);

    const newContact = await contact.save();
    if(!newContact){
        throw new Error('Failed to create contact');
    }

    return newContact;
  }

  async findAll(): Promise<Contact[]> {
    return this.contactModel.find().exec();
  }


}
